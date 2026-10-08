"""把微信读书书架同步到 assets/data/books.json。

走官方 Agent Gateway（不是爬虫）：
    POST https://i.weread.qq.com/api/agent/gateway
    Authorization: Bearer $WEREAD_API_KEY
    Body: {"api_name": "/shelf/sync", "skill_version": "1.0.4"}

设计要点（与 sync_movies.py 保持一致的安全策略）：
  · 合并而不是覆盖：手写的 rating / comment / create_time 永远保留
  · 远端暂时没返回的本地条目保留，不删
  · 原子写入：先写临时文件再替换，不会写到一半损坏
  · 出错就退出且不动原文件
  · 封面主色由本地 Pillow 计算（Gateway 不回传颜色）

用法：
    WEREAD_API_KEY=wrk-xxxx python sync_books.py [--dry-run]
"""

from __future__ import annotations

import argparse
import io
import json
import os
import random
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple

GATEWAY = "https://i.weread.qq.com/api/agent/gateway"
SKILL_VERSION = "1.0.4"
LOCAL_FILE = Path("assets/data/books.json")

#: 手写字段，同步时必须保留
MANUAL_FIELDS = ("rating", "comment", "create_time")

#: 分类只有 1 本时并到这个书架上，避免出现一堆只剩一根书脊的空架子
FALLBACK_SHELF = "书架"


# --------------------------------------------------------------------------
# Gateway 调用
# --------------------------------------------------------------------------

def gateway(api_name: str, api_key: str, **params) -> dict:
    body = {"api_name": api_name, "skill_version": SKILL_VERSION}
    body.update(params)
    request = urllib.request.Request(
        GATEWAY, data=json.dumps(body).encode("utf-8"), method="POST"
    )
    request.add_header("Authorization", "Bearer " + api_key)
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if payload.get("upgrade_info"):
        message = (payload["upgrade_info"] or {}).get("message", "")
        raise RuntimeError("微信读书要求升级 Skill，请先处理：" + str(message))
    errcode = payload.get("errcode")
    if errcode not in (None, 0):
        raise RuntimeError("接口 {} 返回错误 {}：{}".format(
            api_name, errcode, payload.get("errmsg") or payload.get("msg") or ""))
    return payload


def unwrap(payload: dict) -> dict:
    data = payload.get("data")
    return data if isinstance(data, dict) else payload


# --------------------------------------------------------------------------
# 封面主色
# --------------------------------------------------------------------------

def dominant_color(image_bytes: bytes) -> Tuple[str, str]:
    """从封面图取一个适合做书脊的主色，返回 (浅色模式, 深色模式) 两个 #rrggbb。"""
    try:
        from PIL import Image
    except ImportError:
        return "", ""

    try:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception:  # noqa: BLE001 - 封面坏了不该中断同步
        return "", ""

    image = image.resize((64, 96))
    counts = image.getcolors(64 * 96) or []

    # 过滤掉太白、太黑、太灰的颜色——它们做书脊底色都看不清
    candidates = []
    for count, rgb in counts:
        r, g, b = rgb
        lum = (r * 299 + g * 587 + b * 114) / 1000
        if lum < 28 or lum > 210:
            continue
        if max(rgb) - min(rgb) < 16:      # 太灰
            continue
        candidates.append((count, rgb))

    if not candidates:
        # 放宽一点再试
        candidates = [(c, rgb) for c, rgb in counts
                      if 18 < (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 < 232]
    if not candidates:
        return "", ""

    # 取出现最多的那一种，再和整体平均色混合，避免纯色块过于刺眼
    candidates.sort(key=lambda item: item[0], reverse=True)
    top = candidates[: max(1, len(candidates) // 4)]
    r = sum(c * rgb[0] for c, rgb in top) // sum(c for c, _ in top)
    g = sum(c * rgb[1] for c, rgb in top) // sum(c for c, _ in top)
    b = sum(c * rgb[2] for c, rgb in top) // sum(c for c, _ in top)

    def clamp(value: float) -> int:
        return max(0, min(255, int(round(value))))

    # 浅色模式：压暗一点，保证白色书脊文字够清楚
    lum = (r * 299 + g * 587 + b * 114) / 1000
    if lum > 150:
        scale = 150 / lum
        r, g, b = r * scale, g * scale, b * scale

    light = "#{:02x}{:02x}{:02x}".format(clamp(r), clamp(g), clamp(b))
    dark = "#{:02x}{:02x}{:02x}".format(
        clamp(r * 0.52), clamp(g * 0.52), clamp(b * 0.52))
    return light, dark


def fetch_bytes(url: str, timeout: int = 20) -> Optional[bytes]:
    if not url:
        return None
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------
# 同步
# --------------------------------------------------------------------------

def load_local(path: Path) -> List[dict]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def shelf_of(book: dict, category_counts: Dict[str, int]) -> str:
    category = (book.get("category") or "").strip()
    if not category:
        return FALLBACK_SHELF
    top = category.split("-")[0].strip() or FALLBACK_SHELF
    # 只有一本书的分类不单独占一层书架
    return top if category_counts.get(top, 0) >= 2 else FALLBACK_SHELF


def build_books(api_key: str, fetch_cover: bool = True) -> List[dict]:
    payload = gateway("/shelf/sync", api_key)
    data = unwrap(payload)
    shelf_books = data.get("books") or []
    archives = data.get("archive") or []

    # bookId -> 书单名
    archive_of: Dict[str, str] = {}
    for archive in archives:
        name = (archive.get("name") or "").strip()
        for book_id in archive.get("bookIds") or []:
            if name and str(book_id) not in archive_of:
                archive_of[str(book_id)] = name

    # 统计一级分类，决定要不要单独成层
    counts: Dict[str, int] = {}
    for book in shelf_books:
        top = (book.get("category") or "").split("-")[0].strip()
        if top:
            counts[top] = counts.get(top, 0) + 1

    books: List[dict] = []
    total = len(shelf_books)
    for index, book in enumerate(shelf_books, 1):
        book_id = str(book.get("bookId") or "").strip()
        if not book_id:
            continue
        title = (book.get("title") or "").strip()
        print("  [{}/{}] {}".format(index, total, title or book_id))

        # 阅读进度
        progress = 0
        reading_time = 0
        try:
            detail = unwrap(gateway("/book/getprogress", api_key, bookId=book_id))
            inner = detail.get("book") if isinstance(detail.get("book"), dict) else detail
            progress = int(inner.get("progress") or 0)
            reading_time = int(inner.get("readingTime") or 0)
        except Exception as exc:  # noqa: BLE001
            print("        进度读取失败（按 0 处理）：{}".format(exc))
        time.sleep(random.uniform(0.2, 0.5))

        if int(book.get("finishReading") or 0) == 1:
            status = "finished"
        elif progress > 0:
            status = "reading"
        else:
            status = "want"

        entry = {
            "id": book_id,
            "title": title,
            "author": (book.get("author") or "").strip(),
            "cover": book.get("cover") or "",
            "category": (book.get("category") or "").strip(),
            "shelf": archive_of.get(book_id) or shelf_of(book, counts),
            "status": status,
            "progress": progress,
            "readingTime": reading_time,
            "link": book.get("deepLink") or "",
            "secret": int(book.get("secret") or 0),
        }

        if fetch_cover and entry["cover"]:
            image = fetch_bytes(entry["cover"])
            if image:
                light, dark = dominant_color(image)
                if light:
                    entry["dominant_color"] = light
                    entry["dominant_color_dark"] = dark
        books.append(entry)
        time.sleep(random.uniform(0.2, 0.5))

    return books


def merge(local: List[dict], remote: List[dict]) -> Tuple[List[dict], int]:
    """远端为准，但保留手写字段；远端没有的本地条目保留。"""
    existing = {str(b.get("id")): b for b in local}
    merged: List[dict] = []
    kept = 0

    for book in remote:
        old = existing.pop(str(book.get("id")), None)
        if old:
            for field in MANUAL_FIELDS:
                if old.get(field) not in (None, "", []):
                    book[field] = old[field]
                    kept += 1
            # 配色是本地从封面算出来的，接口不返回。这次没取到就沿用上次的 —— 
            # 否则跑一次 --no-cover（或封面临时下载失败）就会把书脊颜色全清掉。
            # 这个坑真实踩过：--no-cover 同步后「有主色 0 本」。
            for field in ("dominant_color", "dominant_color_dark"):
                if not book.get(field) and old.get(field):
                    book[field] = old[field]
                    kept += 1
        merged.append(book)

    merged.extend(existing.values())   # 远端没返回的保留
    return merged, kept


def atomic_write(path: Path, data: List[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), delete=False, suffix=".tmp")
    try:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.close()
        os.replace(handle.name, path)
    finally:
        if os.path.exists(handle.name):
            os.unlink(handle.name)


def main() -> int:
    parser = argparse.ArgumentParser(description="同步微信读书书架到 books.json")
    parser.add_argument("--dry-run", action="store_true", help="只看结果不写文件")
    parser.add_argument("--no-cover", action="store_true", help="跳过封面主色提取（更快）")
    args = parser.parse_args()

    api_key = (os.getenv("WEREAD_API_KEY") or "").strip()
    if not api_key:
        print("❌ 缺少 WEREAD_API_KEY（格式 wrk-xxxxxxxx）", file=sys.stderr)
        return 1

    print("📚 开始从微信读书官方 Gateway 拉取书架…")
    try:
        remote = build_books(api_key, fetch_cover=not args.no_cover)
    except Exception as exc:  # noqa: BLE001
        print("❌ 同步失败，本地 books.json 保持不变：{}".format(exc), file=sys.stderr)
        return 1

    local = load_local(LOCAL_FILE)
    final, kept = merge(local, remote)
    changed = final != local

    by_status: Dict[str, int] = {}
    by_shelf: Dict[str, int] = {}
    for book in final:
        by_status[book["status"]] = by_status.get(book["status"], 0) + 1
        by_shelf[book["shelf"]] = by_shelf.get(book["shelf"], 0) + 1

    print()
    print("  拉到      {} 本".format(len(remote)))
    print("  保留手写  {} 处".format(kept))
    print("  合并后    {} 本".format(len(final)))
    print("  状态      " + "  ".join("{}={}".format(k, v) for k, v in by_status.items()))
    print("  书架      " + "  ".join("{}={}".format(k, v) for k, v in by_shelf.items()))
    print("  有主色    {} 本".format(sum(1 for b in final if b.get("dominant_color"))))

    if args.dry_run:
        print()
        print("  [dry-run] 不写文件。样例：")
        for book in final[:3]:
            copy = dict(book)
            copy["cover"] = (copy.get("cover") or "")[:50] + "…"
            print("    " + json.dumps(copy, ensure_ascii=False))
        return 0

    if not changed:
        print()
        print("☕ 没有变化，books.json 保持原样。")
        return 0

    atomic_write(LOCAL_FILE, final)
    print()
    print("🎉 已写入 {}（共 {} 本）".format(LOCAL_FILE, len(final)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
