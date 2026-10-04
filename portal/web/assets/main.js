(function () {
  "use strict";

  // If this script is unavailable the page should still be readable. The CSS
  // only enables the reveal transition after this marker is present.
  document.documentElement.classList.add("reveal-ready");

  /* ---------- 全部产品目录浮层 ---------- */
  var overlay = document.getElementById("catalog-overlay");
  var openButtons = Array.prototype.slice.call(
    document.querySelectorAll("#open-catalog, #hero-open-catalog, #grid-open-catalog, #footer-open-catalog")
  );
  var closeEls = Array.prototype.slice.call(overlay.querySelectorAll("[data-close]"));
  var searchInput = document.getElementById("catalog-search-input");
  var emptyHint = document.getElementById("catalog-empty");
  var overlayGroups = Array.prototype.slice.call(overlay.querySelectorAll(".cat-group"));
  var lastTrigger = null;

  var productAliases = {
    "RDK Studio": "studio developer ide agent device flash terminal file robot 开发 调试 烧录 设备",
    "RDK 训练平台": "learning training simulation sim2real policy dataset robot train 仿真 训练 评测 部署",
    "RDK 可观测平台": "observability ops monitor monitoring trace alert slo incident reliability telemetry 可观测 运维 监控 链路 告警 事故"
  };

  function setOpenState(isOpen) {
    openButtons.forEach(function (button) {
      button.setAttribute("aria-expanded", String(isOpen && button === lastTrigger));
    });
    overlay.setAttribute("aria-hidden", String(!isOpen));
  }

  function focusableInOverlay() {
    return Array.prototype.slice.call(
      overlay.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])" )
    ).filter(function (element) {
      return !element.hidden && element.offsetParent !== null;
    });
  }

  setOpenState(false);

  function openCatalog(event) {
    if (event && event.currentTarget) lastTrigger = event.currentTarget;
    if (!lastTrigger || !document.body.contains(lastTrigger)) {
      lastTrigger = (document.activeElement && document.activeElement !== document.body)
        ? document.activeElement
        : openButtons[0];
    }
    overlay.hidden = false;
    document.body.classList.add("no-scroll");
    setOpenState(true);
    searchInput.focus();
  }

  function closeCatalog() {
    overlay.hidden = true;
    document.body.classList.remove("no-scroll");
    setOpenState(false);
    if (lastTrigger && document.body.contains(lastTrigger)) lastTrigger.focus();
  }

  openButtons.forEach(function (button) {
    button.addEventListener("click", openCatalog);
  });

  closeEls.forEach(function (el) {
    el.addEventListener("click", closeCatalog);
  });

  document.addEventListener("keydown", function (event) {
    if (overlay.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeCatalog();
      return;
    }
    if (event.key === "Tab") {
      var focusable = focusableInOverlay();
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
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
      var productName = product.querySelector(".ov-product-name");
      var name = productName ? productName.textContent.replace(/HOT|NEW/g, "").trim() : "";
      var haystack = (product.textContent + " " + (productAliases[name] || "")).toLowerCase();
      var visible = query === "" || haystack.indexOf(query) !== -1;
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

  var activeFrame = null;
  function updateActiveNav() {
    activeFrame = null;
    var targetY = window.scrollY + 150;
    var active = "products";
    spied.forEach(function (section) {
      if (section.offsetTop <= targetY) active = section.id;
    });
    setActive(active);
  }

  function scheduleActiveNav() {
    if (activeFrame !== null) return;
    activeFrame = window.requestAnimationFrame(updateActiveNav);
  }

  window.addEventListener("scroll", scheduleActiveNav, { passive: true });
  window.addEventListener("resize", scheduleActiveNav);
  updateActiveNav();

  // A network stall or a blocked animation should never leave the page blank.
  window.setTimeout(function () {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  }, 900);
})();
