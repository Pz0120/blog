/* 书架：悬停 / 聚焦时显示详情卡。
   数据来自页面内嵌的 <script id="books-data">，与 zouguo 页面的做法一致。 */
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

  var card = document.createElement("div");
  card.className = "book-detail-card";
  card.setAttribute("role", "tooltip");
  card.hidden = true;
  document.body.appendChild(card);

  var spines = app.querySelectorAll(".book-spine");
  if (spines.length === 0) return;

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
    facts.push('<span class="book-detail-status">' + (STATUS[status] || "想读") + "</span>");
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

  function place(spine) {
    var rect = spine.getBoundingClientRect();
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

  function show(spine) {
    var index = Number(spine.getAttribute("data-book-index"));
    var book = books[index];
    if (!book) return;

    active = spine;
    render(book);
    card.hidden = false;
    /* 先显示再量尺寸，否则 getBoundingClientRect 拿到的是 0 */
    place(spine);
    card.classList.add("is-visible");
  }

  function hide() {
    active = null;
    card.classList.remove("is-visible");
    card.hidden = true;
  }

  Array.prototype.forEach.call(spines, function (spine) {
    spine.addEventListener("mouseenter", function () {
      show(spine);
    });
    spine.addEventListener("mouseleave", function () {
      if (active === spine) hide();
    });
    spine.addEventListener("focus", function () {
      show(spine);
    });
    spine.addEventListener("blur", function () {
      if (active === spine) hide();
    });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && active) hide();
  });

  window.addEventListener(
    "scroll",
    function () {
      if (active) place(active);
    },
    { passive: true }
  );

  window.addEventListener("resize", function () {
    if (active) place(active);
  });
})();
