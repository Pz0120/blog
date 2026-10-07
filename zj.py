#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zj —— 惊蛰日常写作与发布工具

把「建文件 / 填 Front Matter / 地理编码 / 保手工字段 / 校验 / 提交推送」
收拢成一条命令。零第三方依赖，只用 Python 标准库。

放在站点根目录，然后：

    python zj.py                 # 交互式菜单
    python zj.py post "标题"      # 新建随笔
    python zj.py laodao "内容"    # 发唠叨
    python zj.py zouguo "西湖"    # 记走过（自动地理编码）
    python zj.py sync            # 同步豆瓣观影
    python zj.py books merge raw.json   # 合并书架数据（保留手写评分短评）
    python zj.py pub             # 校验 + 提交 + 推送
    python zj.py status          # 看当前状态
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

# --------------------------------------------------------------------------
# 配置（可用环境变量覆盖）
# --------------------------------------------------------------------------

#: Nominatim 使用政策要求可识别的请求方，务必改成你自己的站点
NOMINATIM_USER_AGENT = os.environ.get(
    "NOMINATIM_USER_AGENT", "JingzheBlog/1.0 (+https://example.org/)"
)
NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search"

ROOT = Path(__file__).resolve().parent

VALID_STATUS = ("finished", "reading", "want")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

# Windows 控制台默认可能是 GBK，中文输出会乱码
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - 老版本 Python
    pass


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

class Fail(Exception):
    """可以友好展示给用户的错误。"""


def say(msg: str = "") -> None:
    print(msg)


def ok(msg: str) -> None:
    print(f"  \u2713 {msg}")


def warn(msg: str) -> None:
    print(f"  ! {msg}")


def die(msg: str) -> None:
    print(f"\n\u2717 {msg}\n", file=sys.stderr)
    raise SystemExit(1)


def run(cmd, cwd=None, check=True, capture=True):
    """跑一个外部命令。找不到可执行文件时抛 Fail。"""
    exe = shutil.which(cmd[0])
    if exe is None:
        raise Fail(f"找不到命令 {cmd[0]}，请确认已安装并在 PATH 中")
    proc = subprocess.run(
        [exe] + list(cmd[1:]),
        cwd=str(cwd or ROOT),
        capture_output=capture,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise Fail(f"命令失败（{proc.returncode}）：{' '.join(cmd)}\n{detail}")
    return proc


def local_now() -> dt.datetime:
    return dt.datetime.now().astimezone()


def iso(d: dt.datetime) -> str:
    """输出带时区的 ISO 时间，秒级精度。"""
    return d.replace(microsecond=0).isoformat()


def parse_when(value: str) -> dt.datetime:
    """接受 YYYY-MM-DD、YYYY-MM-DD HH:MM、YYYY-MM-DDTHH:MM(:SS) 或完整 ISO。"""
    if not value:
        return local_now()
    text = value.strip().replace("/", "-")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            naive = dt.datetime.strptime(text, fmt)
            return naive.astimezone()
        except ValueError:
            continue
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        raise Fail(f"看不懂的时间格式：{value}（试试 2026-10-07 或 '2026-10-07 18:30'）")
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed


def slugify(text: str) -> str:
    """尽量转成 ASCII slug；纯中文会得到空串，交给调用方兜底。"""
    ascii_ish = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return ascii_ish


def safe_filename(text: str) -> str:
    """把标题变成合法文件名，保留中文（上游站点就是这么命名的）。"""
    cleaned = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", text).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:80] or "untitled"


def yaml_str(value: str) -> str:
    """安全地放进 YAML 双引号里。"""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def write_text(path: Path, text: str, overwrite: bool = False) -> None:
    if path.exists() and not overwrite:
        raise Fail(f"文件已存在，未覆盖：{path.relative_to(ROOT)}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def open_in_editor(path: Path) -> None:
    editor = os.environ.get("EDITOR")
    if editor:
        try:
            subprocess.Popen([editor, str(path)])
            return
        except OSError:
            pass
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def template(tag: str) -> str:
    return f"""---
{tag}---
"""


# --------------------------------------------------------------------------
# 地理编码
# --------------------------------------------------------------------------

def geocode(place: str, timeout: int = 20) -> dict:
    """用 Nominatim 把地名转成结构化地点。失败抛 Fail。"""
    params = {
        "q": place,
        "format": "jsonv2",
        "addressdetails": "1",
        "limit": "1",
        "accept-language": "zh-CN",
    }
    url = NOMINATIM_ENDPOINT + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": NOMINATIM_USER_AGENT})

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise Fail(f"地理编码请求被拒绝（HTTP {exc.code}）。请检查 NOMINATIM_USER_AGENT 是否填了真实站点。")
    except urllib.error.URLError as exc:
        raise Fail(f"地理编码失败（网络不可达）：{exc.reason}")
    except (json.JSONDecodeError, TimeoutError) as exc:
        raise Fail(f"地理编码返回异常：{exc}")

    if not payload:
        raise Fail(f"没找到「{place}」。换个更完整的说法，比如「杭州市西湖区」或「杭州 西湖」。")

    hit = payload[0]
    address = hit.get("address") or {}

    country_code = (address.get("country_code") or "").upper()
    country = address.get("country") or ""
    region = address.get("state") or address.get("province") or ""
    locality = (
        address.get("city")
        or address.get("town")
        or address.get("municipality")
        or address.get("county")
        or address.get("city_district")
        or ""
    )

    display = hit.get("display_name") or place
    primary = display.split(",")[0].strip() or place
    if locality and locality not in primary:
        display_name = f"{locality} · {primary}"
    elif region and region not in primary:
        display_name = f"{region} · {primary}"
    else:
        display_name = primary

    return {
        "latitude": round(float(hit["lat"]), 6),
        "longitude": round(float(hit["lon"]), 6),
        "country": country,
        "country_code": country_code,
        "region": region,
        "locality": locality,
        "display_name": display_name,
        "osm_type": hit.get("osm_type", ""),
        "osm_id": hit.get("osm_id", ""),
    }


def make_place_id(place: str, info: dict, override: str = "") -> str:
    if override:
        return override
    slug = slugify(info.get("display_name", "")) or slugify(place)
    if not slug:
        slug = hashlib.md5(place.encode("utf-8")).hexdigest()[:10]
    prefix = (info.get("country_code") or "xx").lower()
    return f"{prefix}-{slug}"[:64]


# --------------------------------------------------------------------------
# 命令：post / laodao
# --------------------------------------------------------------------------

def cmd_post(args) -> int:
    title = args.title.strip()
    if not title:
        raise Fail("标题不能为空")

    filename = safe_filename(title) + ".md"
    target = ROOT / "content" / "posts" / filename
    now = local_now()

    tags = [t.strip() for t in (args.tags or "").split(",") if t.strip()]
    tag_line = "tags: [" + ", ".join(yaml_str(t) for t in tags) + "]"

    body = (
        "---\n"
        f"title: {yaml_str(title)}\n"
        f"date: {iso(now)}\n"
        f"slug: {yaml_str(safe_filename(title))}\n"
        'description: ""\n'
        f"{tag_line}\n"
        f"draft: {'true' if not args.live else 'false'}\n"
        "---\n"
        "\n"
        "从这里开始写正文。\n"
    )

    write_text(target, body)
    ok(f"新建随笔 {target.relative_to(ROOT)}")
    if not args.live:
        say("  （draft: true，`zj pub` 时会自动转成发布）")
    if args.open:
        open_in_editor(target)
    return 0


def cmd_laodao(args) -> int:
    content = args.content.strip()
    now = local_now()
    target = (
        ROOT
        / "content"
        / "laodao"
        / now.strftime("%Y")
        / now.strftime("%m")
        / (now.strftime("%Y%m%d-%H%M%S") + ".md")
    )

    tags = [t.strip() for t in (args.tags or "").split(",") if t.strip()]
    tag_line = "laodaotags: [" + ", ".join(yaml_str(t) for t in tags) + "]"

    body = (
        "---\n"
        f"date: {iso(now)}\n"
        f"{tag_line}\n"
        f"draft: {'true' if not args.live else 'false'}\n"
        "---\n"
        "\n"
        f"{content}\n"
    )

    write_text(target, body)
    ok(f"发出唠叨 {target.relative_to(ROOT)}")
    if args.open:
        open_in_editor(target)
    return 0


# --------------------------------------------------------------------------
# 命令：zouguo
# --------------------------------------------------------------------------

def cmd_zouguo(args) -> int:
    place = args.place.strip()
    if not place:
        raise Fail("地名不能为空")

    when = parse_when(args.at)
    note = (args.note or "").strip()

    say(f"正在地理编码「{place}」…")
    try:
        info = geocode(place)
    except Fail as exc:
        if not args.manual:
            say("")
            say(str(exc))
            say("")
            say("解决办法（任选其一）：")
            say("  1. 换个更完整的说法重试，例如  python zj.py zouguo \"杭州市西湖区\"")
            say("  2. 加 --manual 手工填坐标")
            say("  3. 加 --lat 30.25 --lon 120.15 直接指定")
            raise SystemExit(1)
        info = {
            "latitude": args.lat or 0.0,
            "longitude": args.lon or 0.0,
            "country": "",
            "country_code": "CN",
            "region": "",
            "locality": "",
            "display_name": place,
            "osm_type": "",
            "osm_id": "",
        }

    if args.lat is not None:
        info["latitude"] = args.lat
    if args.lon is not None:
        info["longitude"] = args.lon

    place_id = make_place_id(place, info, args.id)

    block = [
        "zouguo:",
        f"  occurred_at: {iso(when)}",
        "  place:",
        f"    id: {place_id}",
        f"    name: {yaml_str(info['display_name'])}",
        f"    longitude: {info['longitude']}",
        f"    latitude: {info['latitude']}",
        f"    precision: {args.precision}",
    ]
    if info.get("country"):
        block.append(f"    country: {yaml_str(info['country'])}")
    if info.get("country_code"):
        block.append(f"    country_code: {info['country_code']}")
    if info.get("region"):
        block.append(f"    region: {yaml_str(info['region'])}")
    if info.get("locality"):
        block.append(f"    locality: {yaml_str(info['locality'])}")
    block.append(f"    provider: nominatim")
    if info.get("osm_id"):
        block.append(f"    provider_id: {info['osm_type']}/{info['osm_id']}")
    zouguo_block = "\n".join(block) + "\n"

    if args.as_laodao:
        target = (
            ROOT
            / "content"
            / "laodao"
            / when.strftime("%Y")
            / when.strftime("%m")
            / (local_now().strftime("%Y%m%d-%H%M%S") + ".md")
        )
        body = (
            "---\n"
            f"date: {iso(local_now())}\n"
            'laodaotags: ["走过"]\n'
            f"draft: {'true' if not args.live else 'false'}\n"
            f"{zouguo_block}"
            "---\n"
            "\n"
            f"{note}\n"
        )
        kind = "唠叨（带走过 Tag）"
    else:
        stamp = when.strftime("%Y%m%d-%H%M%S")
        target = ROOT / "content" / "zouguo" / f"{stamp}-{uuid.uuid4()}.md"
        body = (
            "---\n"
            'title: ""\n'
            f"date: {iso(local_now())}\n"
            'type: "zouguo"\n'
            f"draft: {'true' if not args.live else 'false'}\n"
            f"{zouguo_block}"
            "---\n"
            "\n"
            f"{note}\n"
        )
        kind = "独立走过"

    write_text(target, body)
    ok(f"记下{kind} {target.relative_to(ROOT)}")
    say(f"    地点  {info['display_name']}")
    say(f"    坐标  {info['latitude']}, {info['longitude']}")
    say(f"    身份  {place_id}")
    if not note:
        say("  （正文还是空的，可以补一句话和图片）")
    if args.open:
        open_in_editor(target)
    return 0


# --------------------------------------------------------------------------
# 命令：sync（豆瓣观影）
# --------------------------------------------------------------------------

def cmd_sync(args) -> int:
    script = ROOT / "sync_movies.py"
    if not script.exists():
        raise Fail("找不到 sync_movies.py（观影模块的程序文件还没复制进来）")
    say("正在同步豆瓣观影数据…")
    proc = run([sys.executable, str(script)], check=False)
    out = (proc.stdout or "") + (proc.stderr or "")
    if out.strip():
        say(out.strip())
    if proc.returncode != 0:
        raise Fail("同步失败。上游脚本在失败时会保留原数据不覆盖，站点是安全的。")
    ok("同步完成")
    say("  下一步：python zj.py pub")
    return 0


# --------------------------------------------------------------------------
# 命令：books
# --------------------------------------------------------------------------

BOOKS_PATH = ROOT / "assets" / "data" / "books.json"
MANUAL_FIELDS = ("rating", "comment", "create_time")


def cmd_books_merge(args) -> int:
    raw_path = Path(args.raw)
    if not raw_path.is_absolute():
        raw_path = (ROOT / raw_path).resolve()
    if not raw_path.exists():
        raise Fail(f"找不到原始数据文件：{raw_path}")

    try:
        incoming = json.loads(raw_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise Fail(f"原始数据不是合法 JSON：{exc}")

    if isinstance(incoming, dict):
        incoming = incoming.get("books") or incoming.get("items") or []
    if not isinstance(incoming, list):
        raise Fail("原始数据的顶层应该是数组（或含 books/items 数组的对象）")

    existing = {}
    if BOOKS_PATH.exists():
        try:
            for book in json.loads(BOOKS_PATH.read_text(encoding="utf-8")):
                existing[str(book.get("id"))] = book
        except json.JSONDecodeError:
            warn("现有 books.json 解析失败，将当作空文件处理")

    merged = []
    kept_manual = 0
    for book in incoming:
        if not isinstance(book, dict):
            continue
        key = str(book.get("id"))
        old = existing.pop(key, None)
        if old:
            for field in MANUAL_FIELDS:
                if old.get(field) not in (None, "", []):
                    book[field] = old[field]
                    kept_manual += 1
        book.setdefault("shelf", "未归类")
        merged.append(book)

    leftovers = list(existing.values())
    if leftovers and not args.prune:
        merged.extend(leftovers)

    if args.dry_run:
        say(f"[dry-run] 将写入 {len(merged)} 本书：")
        say(f"  Skill 新数据   {len(incoming)}")
        say(f"  保留手写字段   {kept_manual} 处")
        say(f"  保留旧有条目   {len(leftovers)}（当前文件里有、这次没返回）")
        return 0

    write_text(BOOKS_PATH, json.dumps(merged, ensure_ascii=False, indent=2) + "\n", overwrite=True)
    ok(f"已写入 {BOOKS_PATH.relative_to(ROOT)}，共 {len(merged)} 本")
    say(f"    保留手写评分/短评 {kept_manual} 处")
    if leftovers:
        say(f"    保留了 {len(leftovers)} 条本次没返回的旧条目" + ("（--prune 可删除）" if not args.prune else ""))
    say("  下一步：python zj.py books check")
    return 0


def cmd_books_check(args) -> int:
    if not BOOKS_PATH.exists():
        raise Fail(f"还没有 {BOOKS_PATH.relative_to(ROOT)}")

    try:
        books = json.loads(BOOKS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        die(f"books.json 不是合法 JSON：{exc}")

    if not isinstance(books, list):
        die("books.json 顶层必须是数组")

    problems = []
    see_ids = {}
    for i, book in enumerate(books):
        where = f"第 {i + 1} 条"
        if not isinstance(book, dict):
            problems.append(f"{where}：不是对象")
            continue
        title = book.get("title") or ""
        ident = str(book.get("id") or "")
        if title:
            where = f"「{title}」"
        if not ident:
            problems.append(f"{where}：缺 id")
        elif ident in see_ids:
            problems.append(f"{where}：id 与第 {see_ids[ident]} 条重复（{ident}）")
        else:
            see_ids[ident] = i + 1
        if not title:
            problems.append(f"第 {i + 1} 条：缺 title")
        status = book.get("status")
        if status not in VALID_STATUS:
            problems.append(f"{where}：status={status!r} 不合法（只能是 {'/'.join(VALID_STATUS)}）")
        if not (book.get("shelf") or "").strip():
            problems.append(f"{where}：shelf 为空（会全被归到「未归类」）")
        for field in ("dominant_color", "dominant_color_dark"):
            value = book.get(field)
            if value and not HEX_RE.match(str(value)):
                problems.append(f"{where}：{field}={value!r} 不是合法 hex（要像 #6dd0ef）")
        progress = book.get("progress")
        if progress is not None:
            try:
                number = float(progress)
                if not 0 <= number <= 100:
                    problems.append(f"{where}：progress={progress} 超出 0-100")
            except (TypeError, ValueError):
                problems.append(f"{where}：progress={progress!r} 不是数字")

    say(f"检查 {BOOKS_PATH.relative_to(ROOT)}：共 {len(books)} 本")
    if problems:
        say("")
        for problem in problems:
            warn(problem)
        say("")
        die(f"发现 {len(problems)} 个问题")
    ok("全部通过")
    shelves = {}
    for book in books:
        shelves[book.get("shelf") or "未归类"] = shelves.get(book.get("shelf") or "未归类", 0) + 1
    for name, count in shelves.items():
        say(f"    {name}  {count} 本")
    return 0


# --------------------------------------------------------------------------
# 命令：setup-mobile（手机网页发布 · A 精简档：只部署 Publisher）
# --------------------------------------------------------------------------

#: A 档需要的全部主题侧文件（源 → 站点，路径相同）
MOBILE_FILES = (
    "content/pages/新唠叨.md",
    "content/pages/新随笔.md",
    "themes/jingzhe_v3/layouts/pages/newlaodao.html",
    "themes/jingzhe_v3/layouts/pages/newsuibi.html",
    "themes/jingzhe_v3/assets/css/newlaodao.css",
    "themes/jingzhe_v3/assets/css/newsuibi.css",
    "themes/jingzhe_v3/assets/js/pages/editor-core.js",
    "themes/jingzhe_v3/assets/js/pages/editor-laodao.js",
    "themes/jingzhe_v3/assets/js/pages/editor-post.js",
    "themes/jingzhe_v3/assets/js/pages/jingzhe-message.js",
    "static/js/marked.min.js",
)

#: 需要整目录复制的部分（A 档只要 Publisher）
MOBILE_TREES = ("workers/publisher",)

PARAMS_PREVIEW = """[features]
  publisher = true

[repository]
  owner = "<你的 GitHub 用户名>"
  name = "<你的博客仓库名>"
  branch = "main"

[services.publisher]
  workerUrl = "https://publisher.<你的域名>"
  draftUrl = ""                                  # A 档不用云草稿，留空
  imageBaseUrl = "https://images.<你的域名>"      # R2 桶的公开访问域名"""


def patch_params(updates: dict, dry_run: bool) -> list:
    """按 TOML 段替换指定键的值，保留注释与其它格式。返回改动列表。"""
    path = ROOT / "config" / "_default" / "params.toml"
    if not path.exists():
        raise Fail(f"找不到 {path.relative_to(ROOT)}")

    lines = path.read_text(encoding="utf-8").splitlines()
    section = ""
    changed = []
    out = []

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped
            out.append(line)
            continue
        if section in updates:
            match = re.match(r"^(\s*)([A-Za-z_][\w-]*)(\s*)=", line)
            if match and match.group(2) in updates[section]:
                key = match.group(2)
                new_line = f"{match.group(1)}{key}{match.group(3)}= {updates[section][key]}"
                if new_line != line:
                    changed.append((section, key, line.strip(), new_line.strip()))
                out.append(new_line)
                continue
        out.append(line)

    if changed and not dry_run:
        path.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")
    return changed


def trees_equal(source: Path, dest: Path) -> bool:
    """比较两棵目录树是否逐文件完全一致。"""
    if not dest.is_dir():
        return False
    src_files = {p.relative_to(source): p for p in source.rglob("*") if p.is_file()}
    dst_files = {p.relative_to(dest): p for p in dest.rglob("*") if p.is_file()}
    if src_files.keys() != dst_files.keys():
        return False
    for rel, src_path in src_files.items():
        if src_path.read_bytes() != dst_files[rel].read_bytes():
            return False
    return True


def cmd_setup_mobile(args) -> int:
    src = Path(args.source).expanduser()
    if not src.is_absolute():
        src = (Path.cwd() / src).resolve()
    if not src.is_dir():
        raise Fail(f"找不到上游 clone 目录：{src}")
    if not (src / "themes" / "jingzhe_v3").is_dir():
        raise Fail(f"{src} 看起来不是惊蛰仓库（没有 themes/jingzhe_v3）")

    say(f"上游来源  {src}")
    say(f"目标站点  {ROOT}")
    say("")

    copied, same, missing = [], [], []

    for rel in MOBILE_FILES:
        source = src / rel
        dest = ROOT / rel
        if not source.exists():
            missing.append(rel)
            continue
        if dest.exists() and dest.read_bytes() == source.read_bytes():
            same.append(rel)
            continue
        if not args.dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
        copied.append(rel)

    for rel in MOBILE_TREES:
        source = src / rel
        if not source.is_dir():
            missing.append(rel + "/")
            continue
        dest = ROOT / rel
        if not args.force and trees_equal(source, dest):
            same.append(rel + "/")
            continue
        if not args.dry_run:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists() and args.force:
                shutil.rmtree(dest)
            shutil.copytree(source, dest, dirs_exist_ok=True)
        copied.append(rel + "/")

    verb = "将复制" if args.dry_run else "已复制"
    if copied:
        say(f"{verb} {len(copied)} 项：")
        for rel in copied:
            say(f"    {rel}")
    if same:
        say(f"已是最新，跳过 {len(same)} 项")
    if missing:
        say("")
        warn(f"上游缺少 {len(missing)} 项（可能版本不一致）：")
        for rel in missing:
            say(f"    {rel}")

    # 样式门控：上游 style.css 应该已经写好了，这里只做确认
    style = ROOT / "themes" / "jingzhe_v3" / "assets" / "css" / "style.css"
    if style.exists():
        text = style.read_text(encoding="utf-8")
        if "newlaodao.css" in text and "feature-enabled.html" in text:
            ok("style.css 已含 publisher 样式门控，无需改动")
        else:
            warn("style.css 里没找到 publisher 样式门控，请手动加上：\n"
                 '      {{ if partial "jingzhe/feature-enabled.html" "publisher" }}\n'
                 '      @import "newlaodao.css";\n'
                 '      @import "newsuibi.css";\n'
                 "      {{ end }}")
    else:
        warn("没找到 themes/jingzhe_v3/assets/css/style.css")

    # 站点配置
    updates = {}
    if args.owner:
        updates.setdefault("[repository]", {})["owner"] = f'"{args.owner}"'
    if args.repo:
        updates.setdefault("[repository]", {})["name"] = f'"{args.repo}"'
    updates.setdefault("[features]", {})["publisher"] = "true"
    updates.setdefault("[services.publisher]", {})["draftUrl"] = '""'
    if args.worker_url:
        updates["[services.publisher]"]["workerUrl"] = f'"{args.worker_url}"'
    if args.image_base_url:
        updates["[services.publisher]"]["imageBaseUrl"] = f'"{args.image_base_url}"'

    say("")
    if args.patch:
        changes = patch_params(updates, dry_run=args.dry_run)
        if not changes:
            ok("params.toml 没有需要改动的键（或已是目标值）")
        else:
            say(f"{'将修改' if args.dry_run else '已修改'} params.toml {len(changes)} 处：")
            for section, key, before, after in changes:
                say(f"    {section}.{key}")
                say(f"        - {before}")
                say(f"        + {after}")
    else:
        say("── 手动把下面这段写进 config/_default/params.toml ──")
        say("")
        say(PARAMS_PREVIEW)
        say("")
        say("  想让它自动改就用：python zj.py setup-mobile --from <路径> --patch \\")
        say('      --owner <用户名> --repo <仓库名> [--worker-url <URL>] [--image-base-url <URL>]')

    say("")
    say("── 接下来该你做的（Cloudflare 侧，必须在你自己账号里执行）──")
    say("  1. cd workers/publisher && npx wrangler login")
    say("  2. npx wrangler r2 bucket create <图片桶名>")
    say("     npx wrangler r2 bucket create <图片桶名>-preview")
    say("  3. GitHub → Fine-grained token → 只选你的博客仓库 → Contents: Read and write")
    say("  4. cp wrangler.example.toml wrangler.toml")
    say("     按 jingzhe-mobile/publisher.wrangler.toml 模板替换所有 <...> 占位")
    say("  5. cp .dev.vars.example .env.production  ← 填 ADMIN_TOKEN 和 GH_TOKEN")
    say("     npx wrangler deploy --secrets-file .env.production")
    say("  6. 给 R2 桶配公开访问域名，回填 IMAGE_BASE_URL 与 params 里的 imageBaseUrl")
    say("  7. 回填 params 里的 workerUrl，然后：python zj.py pub")
    say("")
    say("  完整验收清单见 jingzhe-mobile/README.md 第四节")
    return 0


# --------------------------------------------------------------------------
# 命令：mobile-check（A 档进度自检）
# --------------------------------------------------------------------------

PARAMS_PATH = ("config", "_default", "params.toml")

#: 上游示例值 / 本工具模板占位，出现任何一个都说明还没填
PLACEHOLDER_MARKERS = (
    "<", "your-github-owner", "your-blog-repo", "example.org",
    "your-image-bucket", "replace-with",
)


def params_value(section: str, key: str):
    """从 params.toml 里取一个值（按 TOML 段匹配，只认简单字符串/布尔）。"""
    path = ROOT.joinpath(*PARAMS_PATH)
    if not path.exists():
        return None
    current = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            current = stripped.strip("[]")
            continue
        if current != section:
            continue
        match = re.match(rf"^{re.escape(key)}\s*=\s*(.+?)\s*$", stripped)
        if match:
            value = match.group(1)
            if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
                value = value[1:-1]
            return value
    return None


def probe_url(url: str, timeout: int = 12) -> str:
    """探一下 Worker 是否已部署。任何 HTTP 响应都算可达。"""
    try:
        request = urllib.request.Request(url, method="GET", headers={"User-Agent": "zj-check"})
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return f"可达（HTTP {resp.status}）"
    except urllib.error.HTTPError as exc:
        return f"可达（HTTP {exc.code}）"
    except urllib.error.URLError as exc:
        return f"不可达：{exc.reason}"
    except Exception as exc:  # noqa: BLE001 - 探测失败不该中断检查
        return f"不可达：{exc}"


def cmd_mobile_check(args) -> int:
    say("手机发布 · A 档进度检查")
    say("=" * 56)
    next_step = []

    # ---- 阶段 1：主题侧 ----
    say("")
    say("阶段 1 · 主题侧文件")
    missing = [rel for rel in MOBILE_FILES if not (ROOT / rel).exists()]
    worker_dir = ROOT / "workers" / "publisher"
    if not missing and worker_dir.is_dir():
        ok(f"{len(MOBILE_FILES)} 个文件 + workers/publisher/ 都已就位")
    else:
        for rel in missing:
            warn(f"缺少 {rel}")
        if not worker_dir.is_dir():
            warn("缺少 workers/publisher/")
        next_step.append(
            "跑 python zj.py setup-mobile --from <上游 clone 路径> --dry-run 然后再实跑"
        )

    style = ROOT / "themes" / "jingzhe_v3" / "assets" / "css" / "style.css"
    if style.exists() and "newlaodao.css" in style.read_text(encoding="utf-8"):
        ok("style.css 含 publisher 样式门控")
    else:
        warn("style.css 缺少 publisher 样式门控（setup-mobile 会提示该贴什么）")

    # ---- 阶段 2：Cloudflare 侧 ----
    say("")
    say("阶段 2 · Cloudflare 侧")
    wrangler = worker_dir / "wrangler.toml"
    env_prod = worker_dir / ".env.production"

    if not wrangler.exists():
        warn("workers/publisher/wrangler.toml 还不存在")
        say("        → cp workers/publisher/wrangler.example.toml workers/publisher/wrangler.toml")
        if not next_step:
            next_step.append(
                "cd workers/publisher && cp wrangler.example.toml wrangler.toml，"
                "再按 jingzhe-mobile/publisher.wrangler.toml 填好所有占位"
            )
    else:
        # 只看实际配置，不看注释——模板的注释里会提到 example.org 作为反面示例
        body = "\n".join(
            line for line in wrangler.read_text(encoding="utf-8").splitlines()
            if not line.strip().startswith("#")
        )
        hits = [marker for marker in PLACEHOLDER_MARKERS if marker in body]
        if hits:
            warn(f"wrangler.toml 里还有未替换的占位：{', '.join(hits[:4])}")
            if not next_step:
                next_step.append("把 workers/publisher/wrangler.toml 里的占位全部换成你自己的值")
        else:
            ok("wrangler.toml 已填好，没有残留占位")

    if env_prod.exists():
        ok(".env.production 已存在（Secret 文件，别提交）")
    else:
        warn(".env.production 还不存在")
        say("        → cp workers/publisher/.dev.vars.example workers/publisher/.env.production")
        next_step.append("在 .env.production 里填 ADMIN_TOKEN 和 GH_TOKEN")

    # ---- 阶段 3：回填 ----
    say("")
    say("阶段 3 · 配置回填")
    publisher_on = params_value("features", "publisher")
    if publisher_on == "true":
        ok("[features] publisher = true")
    else:
        warn(f"[features] publisher = {publisher_on!r}（应为 true）")
        next_step.append("python zj.py setup-mobile --from <路径> --patch --owner <用户名> --repo <仓库名>")

    owner = params_value("repository", "owner") or ""
    repo = params_value("repository", "name") or ""
    if owner and repo:
        ok(f"[repository] {owner}/{repo}")
    else:
        warn(f"[repository] owner/name 未填全（owner={owner!r} name={repo!r}）")
        if not next_step:
            next_step.append("补上 params.toml 的 [repository] owner 和 name")

    worker_url = params_value("services.publisher", "workerUrl") or ""
    image_base = params_value("services.publisher", "imageBaseUrl") or ""

    if worker_url:
        ok(f"[services.publisher] workerUrl = {worker_url}")
        if args.probe:
            say(f"        探测中…")
            say(f"        {probe_url(worker_url)}")
    else:
        warn("[services.publisher] workerUrl 还是空的（部署完 Worker 再回填）")
        if not next_step:
            next_step.append("部署 Worker 后回填 workerUrl")

    if image_base:
        ok(f"[services.publisher] imageBaseUrl = {image_base}")
    else:
        warn("[services.publisher] imageBaseUrl 还是空的 ← 漏了它会显示裂图")
        if not next_step:
            next_step.append("给 R2 桶配公开访问域名，回填 imageBaseUrl（两处都要改）")

    # ---- 结论 ----
    say("")
    say("=" * 56)
    if not next_step:
        ok("本地配置看起来齐了。跑 hugo server 验一遍 /newlaodao 再 python zj.py pub")
        return 0
    say("下一步：")
    say(f"  → {next_step[0]}")
    if len(next_step) > 1:
        say("")
        say("之后还有：")
        for step in next_step[1:]:
            say(f"  · {step}")
    say("")
    say("完整步骤见 jingzhe-mobile/RUNBOOK-A.md")
    return 0


# --------------------------------------------------------------------------
# 命令：pub / status
# --------------------------------------------------------------------------

CONTENT_DIRS = ("content/posts", "content/laodao", "content/zouguo")

#: `git add -A` 之前必须确保这些不会进仓库
GITIGNORE_ENTRIES = (
    "public/",
    "resources/",
    ".hugo_build.lock",
    "__pycache__/",
    "*.pyc",
    ".DS_Store",
)

#: 万一 .gitignore 漏了，这些路径会被拦下来，不静默提交
JUNK_MARKERS = ("public/", "resources/", "__pycache__/", ".hugo_build.lock", ".DS_Store")


def ensure_gitignore() -> list:
    """补齐构建产物与缓存的忽略规则，返回本次新增的条目。"""
    path = ROOT / ".gitignore"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    known = {line.strip() for line in existing.splitlines()}
    missing = [entry for entry in GITIGNORE_ENTRIES if entry not in known]
    if missing:
        block = "\n# 由 zj 补充：构建产物与缓存\n" + "\n".join(missing) + "\n"
        path.write_text(existing.rstrip("\n") + "\n" + block, encoding="utf-8", newline="\n")
    return missing


def staged_files() -> list:
    out = run(["git", "diff", "--cached", "--name-only"], check=False).stdout or ""
    return [line.strip().strip('"') for line in out.splitlines() if line.strip()]


def list_changes() -> list:
    """未提交的改动。用 -uall 展开未跟踪目录，否则新仓库只会返回目录名。"""
    out = run(["git", "status", "--porcelain", "-uall"], check=False).stdout or ""
    names = []
    for line in out.splitlines():
        if not line.strip():
            continue
        path = line[3:].strip()
        if " -> " in path:  # 重命名：取新路径
            path = path.split(" -> ")[-1]
        names.append(path.strip().strip('"'))
    return names


def find_junk(files: list) -> list:
    hits = []
    for name in files:
        if any(marker in name for marker in JUNK_MARKERS):
            hits.append(name)
    return hits


def flip_drafts(dry_run: bool) -> list:
    """把内容目录里 draft: true 改成 false。返回改动的相对路径。"""
    changed = []
    for rel in CONTENT_DIRS:
        base = ROOT / rel
        if not base.exists():
            continue
        for path in base.rglob("*.md"):
            text = path.read_text(encoding="utf-8")
            new_text, count = re.subn(
                r"(?m)^draft:\s*true\s*$", "draft: false", text
            )
            if count:
                changed.append(path.relative_to(ROOT).as_posix())
                if not dry_run:
                    path.write_text(new_text, encoding="utf-8", newline="\n")
    return changed


def cmd_pub(args) -> int:
    if not (ROOT / ".git").exists():
        raise Fail("这里不是 Git 仓库（没找到 .git）")

    drafts = flip_drafts(dry_run=True)
    if drafts and not args.keep_draft:
        say(f"把 {len(drafts)} 个草稿转为发布：")
        for name in drafts:
            say(f"    {name}")
        if args.dry_run:
            say("  [dry-run] 未实际修改")
        else:
            flip_drafts(dry_run=False)

    say("")
    say("严格构建校验：hugo --minify --panicOnWarning")
    try:
        proc = run(["hugo", "--minify", "--panicOnWarning"], check=False)
    except Fail as exc:
        raise Fail(str(exc))
    if proc.returncode != 0:
        say((proc.stdout or "") + (proc.stderr or ""))
        die("构建失败，已中止，不会提交或推送。修好再跑一次。")
    ok("构建通过")

    # 先把 .gitignore 补齐，否则 dry-run 会把 public/ 之类的产物也列出来
    added_ignores = ensure_gitignore()
    if added_ignores:
        say(f"已补齐 .gitignore：{', '.join(added_ignores)}")

    files = list_changes()
    if not files:
        say("")
        say("没有需要提交的改动，收工。")
        return 0

    if args.dry_run:
        message = args.message or build_message(files)
        say("")
        say(f"[dry-run] 将提交 {len(files)} 个文件：")
        for name in files[:20]:
            say(f"    {name}")
        if len(files) > 20:
            say(f"    … 还有 {len(files) - 20} 个")
        say(f"  提交信息：{message}")
        return 0

    run(["git", "add", "-A"])

    staged = staged_files()
    junk = find_junk(staged)
    if junk and not args.force:
        run(["git", "reset"], check=False)
        say("")
        warn("暂存区里有构建产物或缓存，已撤销暂存：")
        for name in junk[:15]:
            say(f"    {name}")
        if len(junk) > 15:
            say(f"    … 还有 {len(junk) - 15} 个")
        tops = sorted({name.split("/")[0] for name in junk if "/" in name})
        hint = f"git rm -r --cached {' '.join(tops)}" if tops else "检查 .gitignore"
        die(
            "这些是构建产物，不应该纳入版本控制。\n"
            f"    修复：{hint}\n"
            "    改完重新跑 python zj.py pub；确实要提交就加 --force。"
        )

    message = args.message or build_message(staged)
    run(["git", "commit", "-m", message])
    ok(f"已提交：{message}")

    if args.no_push:
        say("  --no-push：未推送")
        return 0

    push = run(["git", "push"], check=False)
    if push.returncode != 0:
        say((push.stdout or "") + (push.stderr or ""))
        die("推送失败（本地提交还在，修好网络或凭据后重跑 git push）")
    ok("已推送，Actions 会自动构建并部署（约 1-3 分钟）")
    return 0


def build_message(files: list) -> str:
    counts = {}

    def bump(key: str, label: str, unit: str) -> None:
        entry = counts.setdefault(key, {"n": 0, "label": label, "unit": unit})
        entry["n"] += 1

    for name in files:
        if name.startswith("content/posts/"):
            bump("posts", "随笔", "篇")
        elif name.startswith("content/laodao/"):
            bump("laodao", "唠叨", "条")
        elif name.startswith("content/zouguo/"):
            bump("zouguo", "走过", "条")
        elif name.startswith("content/pages/"):
            bump("pages", "页面", "个")
        elif name.endswith("movies.json"):
            bump("movies", "观影数据", "份")
        elif name.endswith("books.json"):
            bump("books", "书架数据", "份")
        elif name.startswith(("themes/", "layouts/", "assets/css/", "assets/js/")):
            bump("theme", "主题", "处")
        elif name.startswith("config/") or name in ("hugo.toml", "hugo.yaml", "hugo.json"):
            bump("config", "配置", "处")
        else:
            bump("other", "其他文件", "个")

    order = ("posts", "laodao", "zouguo", "pages", "movies", "books", "theme", "config", "other")
    parts = [
        f"{counts[key]['n']}{counts[key]['unit']}{counts[key]['label']}"
        for key in order
        if key in counts
    ]
    if not parts:
        return "chore: 更新站点"
    return "content: 更新 " + "、".join(parts)


def cmd_status(args) -> int:
    if not (ROOT / ".git").exists():
        raise Fail("这里不是 Git 仓库（没找到 .git）")

    changes = list_changes()

    say(f"站点根目录  {ROOT}")
    say(f"未提交改动  {len(changes)} 个")
    for name in changes[:30]:
        say(f"    {name}")
    if len(changes) > 30:
        say(f"    … 还有 {len(changes) - 30} 个")

    drafts = flip_drafts(dry_run=True)
    say("")
    if drafts:
        say(f"草稿（尚未发布）  {len(drafts)} 篇")
        for name in drafts[:10]:
            say(f"    {name}")
        if len(drafts) > 10:
            say(f"    … 还有 {len(drafts) - 10} 篇")
    else:
        say("草稿  无")

    if BOOKS_PATH.exists():
        try:
            books = json.loads(BOOKS_PATH.read_text(encoding="utf-8"))
            say("")
            say(f"书架  {len(books)} 本")
        except json.JSONDecodeError:
            warn("books.json 解析失败")

    movies_path = ROOT / "assets" / "data" / "movies.json"
    if movies_path.exists():
        try:
            movies = json.loads(movies_path.read_text(encoding="utf-8"))
            say(f"观影  {len(movies)} 部")
        except json.JSONDecodeError:
            warn("movies.json 解析失败")
    return 0


# --------------------------------------------------------------------------
# 交互式菜单
# --------------------------------------------------------------------------

MENU = """
惊蛰日常工具
─────────────────────────────
  1  写随笔
  2  发唠叨
  3  记走过
  4  同步观影（豆瓣）
  5  检查书架数据
  6  发布上线（校验 + 提交 + 推送）
  7  看当前状态
  q  退出
"""


def menu(args) -> int:
    while True:
        say(MENU)
        try:
            choice = input("选择 > ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            say("")
            return 0

        try:
            if choice == "1":
                title = input("标题 > ").strip()
                if title:
                    cmd_post(argparse.Namespace(title=title, tags="", live=False, open=True))
            elif choice == "2":
                content = input("内容 > ").strip()
                if content:
                    cmd_laodao(argparse.Namespace(content=content, tags="", live=False, open=False))
            elif choice == "3":
                place = input("地名 > ").strip()
                if place:
                    note = input("一句话（可空）> ").strip()
                    cmd_zouguo(
                        argparse.Namespace(
                            place=place, note=note, at="", precision="poi",
                            id="", as_laodao=False, manual=False,
                            lat=None, lon=None, live=False, open=False,
                        )
                    )
            elif choice == "4":
                cmd_sync(argparse.Namespace())
            elif choice == "5":
                cmd_books_check(argparse.Namespace())
            elif choice == "6":
                cmd_pub(argparse.Namespace(message="", dry_run=False, no_push=False,
                                           keep_draft=False, force=False))
            elif choice == "7":
                cmd_status(argparse.Namespace())
            elif choice in ("q", "quit", "exit"):
                return 0
            else:
                warn("没这个选项")
        except Fail as exc:
            say("")
            warn(str(exc))
        except SystemExit:
            pass
        say("")
        try:
            input("回车继续…")
        except (EOFError, KeyboardInterrupt):
            return 0
        say("")


# --------------------------------------------------------------------------
# 参数解析
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="zj",
        description="惊蛰日常写作与发布工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python zj.py post \"读《心流》有感\"\n"
            "  python zj.py laodao \"今天风很大\"\n"
            "  python zj.py zouguo \"杭州市西湖区\" \"湖边走了很久\"\n"
            "  python zj.py books merge raw.json\n"
            "  python zj.py pub\n"
            "  python zj.py setup-mobile --from ../blog --patch --owner me --repo my-blog\n"
        ),
    )
    sub = parser.add_subparsers(dest="command")

    p_post = sub.add_parser("post", help="新建随笔")
    p_post.add_argument("title", help="文章标题")
    p_post.add_argument("--tags", default="", help="逗号分隔的标签")
    p_post.add_argument("--live", action="store_true", help="直接发布（不加 draft: true）")
    p_post.add_argument("--open", action="store_true", help="创建后打开编辑器")
    p_post.set_defaults(func=cmd_post)

    p_laodao = sub.add_parser("laodao", help="发一条唠叨")
    p_laodao.add_argument("content", help="唠叨正文")
    p_laodao.add_argument("--tags", default="", help="逗号分隔的标签（会写进 laodaotags）")
    p_laodao.add_argument("--live", action="store_true", help="直接发布")
    p_laodao.add_argument("--open", action="store_true", help="创建后打开编辑器")
    p_laodao.set_defaults(func=cmd_laodao)

    p_zouguo = sub.add_parser("zouguo", help="记一条走过（自动地理编码）")
    p_zouguo.add_argument("place", help="地名，越具体越准，如「杭州市西湖区」")
    p_zouguo.add_argument("note", nargs="?", default="", help="一句话（写进正文）")
    p_zouguo.add_argument("--at", default="", help="经过时间，默认现在；如 '2026-10-07 18:30'")
    p_zouguo.add_argument("--precision", default="poi",
                          choices=["exact", "poi", "locality", "approximate"],
                          help="公开坐标精度（默认 poi）")
    p_zouguo.add_argument("--id", default="", help="手动指定 place.id（保持地点身份稳定）")
    p_zouguo.add_argument("--as-laodao", action="store_true", dest="as_laodao",
                          help="写成带「走过」Tag 的唠叨，而不是独立走过")
    p_zouguo.add_argument("--manual", action="store_true", help="地理编码失败时不报错，改用手工坐标")
    p_zouguo.add_argument("--lat", type=float, default=None, help="直接指定纬度")
    p_zouguo.add_argument("--lon", type=float, default=None, help="直接指定经度")
    p_zouguo.add_argument("--live", action="store_true", help="直接发布")
    p_zouguo.add_argument("--open", action="store_true", help="创建后打开编辑器")
    p_zouguo.set_defaults(func=cmd_zouguo)

    p_sync = sub.add_parser("sync", help="同步豆瓣观影数据")
    p_sync.set_defaults(func=cmd_sync)

    p_books = sub.add_parser("books", help="书架数据")
    books_sub = p_books.add_subparsers(dest="books_command")

    p_merge = books_sub.add_parser("merge", help="把 Skill 原始输出合并进 books.json（保留手写评分短评）")
    p_merge.add_argument("raw", help="Skill 输出的 JSON 文件路径")
    p_merge.add_argument("--prune", action="store_true", help="删除本次没返回的旧条目")
    p_merge.add_argument("--dry-run", action="store_true", help="只看结果不写文件")
    p_merge.set_defaults(func=cmd_books_merge)

    p_check = books_sub.add_parser("check", help="校验 books.json")
    p_check.set_defaults(func=cmd_books_check)

    p_books.set_defaults(func=lambda a: (p_books.print_help(), 1)[1])

    p_pub = sub.add_parser("pub", help="校验 + 提交 + 推送")
    p_pub.add_argument("-m", "--message", default="", help="自定义提交信息")
    p_pub.add_argument("--dry-run", action="store_true", help="只预览不执行")
    p_pub.add_argument("--no-push", action="store_true", help="只提交不推送")
    p_pub.add_argument("--keep-draft", action="store_true", help="不自动把草稿转为发布")
    p_pub.add_argument("--force", action="store_true", help="即使暂存区有构建产物也照常提交")
    p_pub.set_defaults(func=cmd_pub)

    p_status = sub.add_parser("status", help="看当前状态")
    p_status.set_defaults(func=cmd_status)

    p_mobile = sub.add_parser(
        "setup-mobile",
        help="从上游 clone 复制手机网页发布（A 档：只 Publisher）所需文件",
    )
    p_mobile.add_argument("--from", dest="source", required=True,
                          help="上游 koobai/blog clone 的路径")
    p_mobile.add_argument("--patch", action="store_true",
                          help="同时修改 config/_default/params.toml")
    p_mobile.add_argument("--owner", default="", help="GitHub 用户名 → [repository] owner")
    p_mobile.add_argument("--repo", default="", help="仓库名 → [repository] name")
    p_mobile.add_argument("--worker-url", default="", help="Publisher Worker 地址")
    p_mobile.add_argument("--image-base-url", default="", help="R2 桶公开访问域名")
    p_mobile.add_argument("--dry-run", action="store_true", help="只预览不写文件")
    p_mobile.add_argument("--force", action="store_true",
                          help="workers/publisher 已存在时先删除再复制")
    p_mobile.set_defaults(func=cmd_setup_mobile)

    p_mcheck = sub.add_parser("mobile-check", help="A 档进度自检：告诉你现在卡在哪一步")
    p_mcheck.add_argument("--probe", action="store_true",
                          help="顺便探一下 Worker 是否已部署（需要联网）")
    p_mcheck.set_defaults(func=cmd_mobile_check)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not getattr(args, "command", None):
        return menu(args)

    try:
        return args.func(args)
    except Fail as exc:
        die(str(exc))
    except KeyboardInterrupt:
        say("")
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
