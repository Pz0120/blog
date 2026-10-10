(function () {
  "use strict";
  /* 把文章正文里连续的 figure.post-figure 包进 .moment-grid（朋友圈/微博式图片网格）。
     分组放 JS 而不是模板：render-image 钩子逐张渲染，模板层看不到“连续”；
     JS 挂了也只是退回竖排样式。 */
  var content = document.querySelector(".page-blog-single .article-content");
  if (!content) return;
  var kids = Array.prototype.slice.call(content.children);
  var i = 0;
  while (i < kids.length) {
    if (kids[i].classList.contains("post-figure")) {
      var j = i;
      while (j < kids.length && kids[j].classList.contains("post-figure")) j++;
      var run = kids.slice(i, j);
      if (run.length >= 2) {
        var grid = document.createElement("div");
        grid.className = "moment-grid";
        grid.setAttribute("data-n", String(Math.min(run.length, 9)));
        content.insertBefore(grid, run[0]);
        run.forEach(function (el) { grid.appendChild(el); });
      }
      i = j;
    } else {
      i++;
    }
  }
})();