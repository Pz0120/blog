/* 书架 / books.js
   · 封面墙：鼠标悬停或键盘聚焦时弹出详情卡（只在该设备真有指针时启用）
   · 书单筛选：只有多于一个书单时页面上才有筛选条
   数据来自页面内嵌的 <script id="books-data">，与 zouguo 页面做法一致。 */
(function () {
  "use strict";

  var app = document.getElementById("books-app");
  var dataEl = document.getElementById("books-data");
  if (!app || !dataEl) return;

  var books;
  try {
    books = JSON.parse(dataEl.textContent);
  } catch (err) {
    return;
  }
  if (!Array.isArray(books) || books.length === 0) return;

  var STATUS = { finished: "读完", reading: "在读", want: "想读" };

  /* ---------------------------------------------------------------------
     书单筛选
     单书单时模板不会渲染筛选条，这里的 chips 为空，整段自然跳过。
     --------------------------------------------------------------------- */
  var chips = app.querySelectorAll("[data-shelf-filter]");
  var items = app.querySelectorAll(".books-grid-item");
  var emptyHint = app.querySelector(".books-filter-empty");

  function applyFilter(shelf) {
    var shown = 0;
    Array.prototype.forEach.call(items, function (item) {
      var match = shelf === "*" || item.getAttribute("data-shelf") === shelf;
      item.hidden = !match;
      if (match) shown += 1;
    });
    if (emptyHint) emptyHint.hidden = shown !== 0;
  }

  Array.prototype.forEach.call(chips, function (chip) {
    chip.addEventListener("click", function () {
      Array.prototype.forEach.call(chips, function (other) {
        var isSelf = other === chip;
        other.classList.toggle("is-active", isSelf);
        other.setAttribute("aria-pressed", isSelf ? "true" : "false");
      });
      applyFilter(chip.getAttribute("data-shelf-filter"));
    });
  });

  /* ---------------------------------------------------------------------
     详情卡
     触屏没有 hover，聚焦也只会一闪而过 —— 那种设备上直接不启用，
     不做一个"点了没反应"的假交互。手机上书名/作者/状态本来就常显，
     点按直接跳微信读书，信息是完整的。
     --------------------------------------------------------------------- */
  var HOVERABLE =
    window.matchMedia &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  var tiles = app.querySelectorAll(".book-tile");
  if (!HOVERABLE || tiles.length === 0) return;

  var card = document.createElement("div");
  card.className = "book-detail-card";
  card.setAttribute("role", "tooltip");
  card.hidden = true;
  document.body.appendChild(card);

  var active = null;

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(
      /[&<>"']/g,
      function (ch) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[ch];
      }
    );
  }

  function humanTime(seconds) {
    var total = Number(seconds) || 0;
    if (total <= 0) return "";
    var hours = total / 3600;
    if (hours >= 1) return hours.toFixed(1) + " 小时";
    return Math.max(1, Math.round(total / 60)) + " 分钟";
  }

  function stars(rating) {
    var value = Number(rating) || 0;
    if (value <= 0) return "";
    var full = Math.floor(value);
    var out = "";
    for (var i = 0; i < 5; i += 1) out += i < full ? "★" : "☆";
    return out;
  }

  function render(book) {
    var status = book.status || "want";
    var progress = status === "finished" ? 100 : Number(book.progress) || 0;

    var meta = [];
    if (book.author) meta.push(esc(book.author));
    if (book.translator) meta.push("译 " + esc(book.translator));
    if (book.publisher) meta.push(esc(book.publisher));

    var facts = [];
    facts.push(
      '<span class="book-detail-status">' + (STATUS[status] || "想读") + "</span>"
    );
    if (status === "reading" && progress > 0) {
      facts.push('<span class="book-detail-progress">已读 ' + progress + "%</span>");
    }
    var spent = humanTime(book.readingTime);
    if (spent) facts.push('<span class="book-detail-time">' + spent + "</span>");

    var html = '<div class="book-detail-inner">';

    if (book.cover) {
      html +=
        '<div class="book-detail-cover"><img src="' +
        esc(book.cover) +
        '" alt="" loading="lazy" decoding="async"></div>';
    }

    html += '<div class="book-detail-body">';
    html += '<p class="book-detail-title">' + esc(book.title) + "</p>";
    if (meta.length) {
      html += '<p class="book-detail-meta">' + meta.join(" · ") + "</p>";
    }
    html += '<p class="book-detail-facts">' + facts.join("") + "</p>";

    var score = stars(book.rating);
    if (score) html += '<p class="book-detail-stars">' + score + "</p>";
    if (book.comment) {
      html += '<p class="book-detail-comment">' + esc(book.comment) + "</p>";
    }
    html += "</div></div>";

    card.innerHTML = html;
  }

  /* 定位：把卡片尽量摆在触发项上方，并夹在视口内 */
  function place(tile) {
    var rect = tile.getBoundingClientRect();
    var cardRect = card.getBoundingClientRect();
    var gap = 12;

    var left = rect.left + rect.width / 2 - cardRect.width / 2;
    var maxLeft = window.innerWidth - cardRect.width - gap;
    left = Math.max(gap, Math.min(left, maxLeft));

    var top = rect.top - cardRect.height - gap;
    if (top < gap) top = rect.bottom + gap;
    var maxTop = window.innerHeight - cardRect.height - gap;
    top = Math.max(gap, Math.min(top, maxTop));

    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  function show(tile) {
    var index = Number(tile.getAttribute("data-book-index"));
    var book = books[index];
    if (!book) return;

    active = tile;
    render(book);
    card.hidden = false;
    /* 先显示再量尺寸，否则 getBoundingClientRect 拿到的是 0 */
    place(tile);
    card.classList.add("is-visible");
  }

  function hide() {
    active = null;
    card.classList.remove("is-visible");
    card.hidden = true;
  }

  Array.prototype.forEach.call(tiles, function (tile) {
    tile.addEventListener("mouseenter", function () {
      show(tile);
    });
    tile.addEventListener("mouseleave", function () {
      if (active === tile) hide();
    });
    /* 键盘 Tab 到封面时也显示，focus 是可达性入口不是装饰 */
    tile.addEventListener("focus", function () {
      show(tile);
    });
    tile.addEventListener("blur", function () {
      if (active === tile) hide();
    });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && active) hide();
  });

  /* 页面滚动时用 rAF 节流重新定位：每帧最多一次读写，
     避免未节流的 scroll 回调逐帧触发布局。 */
  var ticking = false;
  window.addEventListener(
    "scroll",
    function () {
      if (!active || ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        ticking = false;
        if (active) place(active);
      });
    },
    { passive: true }
  );

  window.addEventListener("resize", function () {
    if (active) place(active);
  });
})();
