(function () {
  "use strict";

  /* ---------- 全部产品目录浮层 ---------- */
  var overlay = document.getElementById("catalog-overlay");
  var openButtons = Array.prototype.slice.call(
    document.querySelectorAll("#open-catalog, #hero-open-catalog, #grid-open-catalog, #footer-open-catalog")
  );
  var closeEls = Array.prototype.slice.call(overlay.querySelectorAll("[data-close]"));
  var searchInput = document.getElementById("catalog-search-input");
  var emptyHint = document.getElementById("catalog-empty");
  var overlayGroups = Array.prototype.slice.call(overlay.querySelectorAll(".cat-group"));

  function openCatalog() {
    overlay.hidden = false;
    document.body.classList.add("no-scroll");
    searchInput.focus();
  }

  function closeCatalog() {
    overlay.hidden = true;
    document.body.classList.remove("no-scroll");
  }

  openButtons.forEach(function (button) {
    button.addEventListener("click", openCatalog);
  });

  closeEls.forEach(function (el) {
    el.addEventListener("click", closeCatalog);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !overlay.hidden) closeCatalog();
  });

  overlay.querySelectorAll(".ov-product").forEach(function (link) {
    link.addEventListener("click", closeCatalog);
  });

  if (location.hash === "#all-products") openCatalog();

  var query = "";
  searchInput.addEventListener("input", function () {
    query = searchInput.value.trim().toLowerCase();
    var totalVisible = 0;

    overlayGroups.forEach(function (group) {
      var product = group.querySelector(".ov-product");
      var visible = query === "" || product.textContent.toLowerCase().indexOf(query) !== -1;
      group.hidden = !visible;
      if (visible) totalVisible += 1;
    });

    emptyHint.hidden = totalVisible !== 0;
  });

  /* ---------- 入场动效 ---------- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll(".reveal"));

  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var revealer = new IntersectionObserver(
      function (observed) {
        observed.forEach(function (item) {
          if (item.isIntersecting) {
            item.target.classList.add("in");
            revealer.unobserve(item.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px" }
    );
    revealEls.forEach(function (el) { revealer.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------- 导航高亮 ---------- */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".top-nav a[data-spy]"));
  var spied = navLinks
    .map(function (link) { return document.getElementById(link.dataset.spy); })
    .filter(Boolean);

  function setActive(id) {
    navLinks.forEach(function (link) {
      link.classList.toggle("is-active", link.dataset.spy === id);
    });
  }

  if ("IntersectionObserver" in window) {
    var current = "top";
    var observer = new IntersectionObserver(
      function (observed) {
        observed.forEach(function (item) {
          if (item.isIntersecting) current = item.target.id;
        });
        setActive(current);
      },
      { rootMargin: "-30% 0px -60% 0px" }
    );
    spied.forEach(function (section) { observer.observe(section); });
  }
})();
