// v1.1.0
class GridButtonCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._finalConfig = {};
    this._variables = {};
    this._initialMounted = false;
    this._isInitialContentLoaded = false;
    this._syncStateDelay = 1000;

    this.BUILT_IN_AREAS = ["icon", "name", "state", "label"];

    this._highlightKey = "";
    this._optimisticHighlightKey = null;
    this._highlightRollbackTimer = null;
    this._contentUpdateTimer = null;
    this._isUpdatingOptimistically = false;

    this._hlEl = null;
    this._lastTarget = { key: "", x: 0, y: 0, w: 0, h: 0, color: "" };

    this._firstShown = false;
    this._allowAnimation = false;

    this._resizeObserver = null;
    this._onResizeRef = () => this._scheduleMove();

    this._rafMove = 0;
    this._measureRetryCount = 0;
    this._measureRetryMax = 60;
    this._viewMo = null;

    // 全局确认层
    this._confirmRoot = null;       // backdrop
    this._confirmDialogEl = null;   // dialog
    this._confirmTextEl = null;     // text node
    this._confirmShown = false;
    this._pendingConfirm = null;
    this._confirmAnchorEl = null;
    this._repositionHandler = null;
    this._repositionRAF = 0;
  }

  /* ================== HA Lifecycle ================== */

  setConfig(config) {
    if (!config) throw new Error("grid-button-card: 配置无效。");
    const { finalCfg, finalVars } = this._resolveTemplatesAndVariables(config);
    this._finalConfig = finalCfg || {};
    this._variables = finalVars || {};

    const delay = this._finalConfig.sync_state_delay;
    this._syncStateDelay = (typeof delay === 'number' && delay >= 0) ? delay : 1000;

    if (!this.shadowRoot.querySelector(".grid-container")) this._render();
  }

  set hass(hass) {
    if (!hass) return;
    const old = this._hass;
    this._hass = hass;

    if (!this._initialMounted || hass.states !== old?.states) {
      if (this._isUpdatingOptimistically) return;

      if (!this._initialMounted) {
        this._initialMounted = true;
        this._mountButtons();
      }
      this._applyDynamicStyles();
      this._applyButtonContent();
      this._updateHighlightTarget();
    }

    this.shadowRoot?.querySelectorAll(".grid-item > *:not(.built-in-element)").forEach((el) => {
      if (el) el.hass = hass;
    });
  }

  /* ================== Structure ================== */

  _render() {
    const style = document.createElement("style");
    style.textContent = `
      .grid-container {
        display: grid;
        width: 100%;
        position: relative;
        isolation: isolate;
        contain: paint;
      }
      .grid-item {
        position: relative;
        box-sizing: border-box; min-width: 0; min-height: 0; overflow: visible;
        display: flex; align-items: stretch; justify-content: stretch;
      }
      .grid-item > * { width: 100%; height: 100%; }

      .btn {
        position: relative;
        width: 100%; height: 100%;
        display: grid;
        box-sizing: border-box;
        border-radius: var(--gbc-radius, 10px);
        cursor: pointer; user-select: none;
        transition: background-color 220ms ease, box-shadow 220ms ease, transform 160ms ease;
      }

      .btn-grid {
        position: relative;
        z-index: 2;
        display: grid; width: 100%; height: 100%;
      }

      .part {
        min-width: 0; min-height: 0;
        transition: opacity 400ms ease;
      }
      .part.name, .part.state, .part.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .part.icon { display: flex; align-items: center; justify-content: center; }
      .part img { max-width: 100%; max-height: 100%; object-fit: contain; }
      .part ha-icon { display: inline-block; }

      /* 高亮层使用 top/left/width/height 过渡（iOS 稳定） */
      .gbc-highlight {
        position: absolute;
        top: 0; left: 0;
        z-index: 1;
        pointer-events: none;
        border-radius: var(--gbc-radius, 10px);
        opacity: 1;
        transition:
          top 420ms cubic-bezier(0.2, 0.9, 0.2, 1),
          left 420ms cubic-bezier(0.2, 0.9, 0.2, 1),
          width 420ms cubic-bezier(0.2, 0.9, 0.2, 1),
          height 420ms cubic-bezier(0.2, 0.9, 0.2, 1),
          background-color 240ms ease,
          border-radius 240ms ease,
          opacity 240ms ease;
        will-change: top, left, width, height, background-color;
        box-shadow: 0 6px 18px rgba(0,0,0,0.18);
      }
    `;

    const wrapper = document.createElement("div");
    wrapper.className = "grid-container";
    wrapper.addEventListener("click", (e) => this._handleTap(e));

    this.shadowRoot.innerHTML = "";
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(wrapper);

    if (window.provideHass) window.provideHass(this);

    this._resizeObserver?.disconnect();
    this._resizeObserver = new ResizeObserver(() => this._scheduleMove());
    this._resizeObserver.observe(wrapper);
    window.addEventListener("resize", this._onResizeRef);

    const findViewHost = () => {
      let n = this;
      const getHost = (x) => (x && x.getRootNode && x.getRootNode() instanceof ShadowRoot) ? x.getRootNode().host : null;
      while (n) {
        if (n.tagName && /^(HUI-|HOMECARD-|STACK-IN-CARD)/i.test(n.tagName)) break;
        const host = getHost(n);
        n = n.parentNode || host;
      }
      while (n) {
        if (n.tagName && /^(HUI-VIEW|HUI-PANEL-VIEW)/i.test(n.tagName)) return n;
        n = n.parentNode || getHost(n);
      }
      return null;
    };

    this._viewMo?.disconnect?.();
    const view = findViewHost();
    if (view) {
      this._viewMo = new MutationObserver(() => {
        this._measureRetryCount = 0;
        this._scheduleMove(true);
      });
      this._viewMo.observe(view, { attributes: true, attributeFilter: ["hidden", "style", "class"] });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    this._resizeObserver?.disconnect();
    this._viewMo?.disconnect?.();
    this._viewMo = null;
    if (this._rafMove) cancelAnimationFrame(this._rafMove), this._rafMove = 0;
    window.removeEventListener("resize", this._onResizeRef);
    clearTimeout(this._highlightRollbackTimer);
    clearTimeout(this._contentUpdateTimer);
    this._teardownConfirmLayer();
  }

  _mountButtons() {
    const wrapper = this.shadowRoot.querySelector(".grid-container");
    if (!wrapper) return;

    wrapper.querySelectorAll(".grid-item").forEach(el => el.remove());

    const btns = this._finalConfig?.button_grid || {};
    for (const areaName of Object.keys(btns)) {
      const div = document.createElement("div");
      div.className = "grid-item";
      div.dataset.area = areaName;

      const btn = document.createElement("div");
      btn.className = "btn";
      btn.dataset.key = areaName;

      const inner = document.createElement("div");
      inner.className = "btn-grid";
      btn.appendChild(inner);

      for (const area of this.BUILT_IN_AREAS) {
        const part = document.createElement("div");
        part.className = `part ${area}`;
        part.dataset.part = area;
        inner.appendChild(part);
      }

      div.appendChild(btn);
      wrapper.appendChild(div);
    }

    this._applyDynamicStyles();
    this._applyButtonContent();
  }

  /* ================== Styles ================== */
  _applyDynamicStyles() {
    if (!this._finalConfig || !this.shadowRoot) return;
    const wrapper = this.shadowRoot.querySelector(".grid-container");
    if (!wrapper) return;

    const normalizedGridText = this._normalizeTopGridStyles(this._finalConfig.styles?.grid);
    const cardText = this._arrayStylesToString(this._finalConfig.styles?.card);
    const pointer =
      this._finalConfig.tap_action && this._finalConfig.tap_action.action !== "none"
        ? "cursor: pointer;"
        : "";
    wrapper.style.cssText = `${normalizedGridText}${cardText}${pointer}`;

    const btns = this._finalConfig?.button_grid || {};
    this.shadowRoot.querySelectorAll(".grid-item").forEach((el) => {
      const areaName = el.dataset.area;
      el.style.cssText = `grid-area: ${areaName};`;
    });

    this.shadowRoot.querySelectorAll(".btn").forEach((btnEl) => {
      const key = btnEl.dataset.key;
      const cfg = btns[key] || {};

      const cardCss = this._arrayStylesToString(cfg.styles?.card);
      btnEl.style.cssText = cardCss;

      const bgColor = btnEl.style.backgroundColor || "";
      btnEl.dataset.originalBg = bgColor;

      let hlColor = this._evaluateTemplate(cfg.sync_button_highlight);
      if (!hlColor || String(hlColor).trim() === "") hlColor = "rgba(0, 150, 255, 0.18)";
      btnEl.dataset.highlightColor = String(hlColor);

      const inner = btnEl.querySelector(".btn-grid");
      if (inner) {
        const innerCss = this._arrayStylesToString(cfg.styles?.grid);
        inner.style.cssText = innerCss.includes("display:") ? innerCss : `display: grid;${innerCss}`;
      }

      for (const area of this.BUILT_IN_AREAS) {
        const part = btnEl.querySelector(`.part.${area}`);
        if (!part) continue;

        const userPartCss = this._arrayStylesToString(cfg.styles?.[area]);

        let mdiSize = "";
        if (area === "icon" && Array.isArray(cfg.styles?.icon)) {
          const kv = {};
          for (const o of cfg.styles.icon) {
            if (o && typeof o === "object") {
              for (const [k, v] of Object.entries(o)) {
                const vv = this._evaluateTemplate(v);
                if (vv !== undefined && vv !== null && String(vv) !== "") kv[k] = String(vv);
              }
            }
          }
          mdiSize = kv["--mdc-icon-size"] || kv["font-size"] ||
            (kv["width"] && kv["height"] && kv["width"] === kv["height"] ? kv["width"] : (kv["width"] || kv["height"] || ""));
          if (mdiSize && /^\d+(\.\d+)?$/.test(mdiSize)) mdiSize = mdiSize + "px";
          if (mdiSize) part.dataset.mdiSize = mdiSize; else part.removeAttribute("data-mdi-size");
        } else {
          part.removeAttribute("data-mdi-size");
        }

        const keepDisplay = part.style.display && part.style.display !== "";
        part.style.cssText = `grid-area: ${area};${userPartCss}${keepDisplay ? `display:${part.style.display};` : ""}`;
      }
    });

    this._scheduleMove();
  }

  /* ================== Content ================== */
  _applyButtonContent() {
    const btns = this._finalConfig?.button_grid || {};
    Object.keys(btns).forEach((key) => {
      const cfg = btns[key];
      const selector = window.CSS?.escape ? CSS.escape(key) : key;
      const btnEl = this.shadowRoot.querySelector(`.btn[data-key="${selector}"]`);
      if (!btnEl) return;

      for (const area of this.BUILT_IN_AREAS) {
        const part = btnEl.querySelector(`.part.${area}`);
        const rawVal = cfg[area];
        if (!part) continue;

        const shouldAnimate = this._isInitialContentLoaded;

        if (rawVal === undefined || rawVal === null || String(rawVal) === "") {
          if (part.style.display !== 'none') {
            part.style.display = 'none';
            part.innerHTML = '';
          }
          continue;
        }

        if (part.style.display === 'none') {
          part.innerHTML = '';
          part.style.display = '';
          part.style.opacity = 1;
        }

        const content = this._evaluateTemplate(rawVal);

        const applyUpdate = (updateFn) => {
          const style = window.getComputedStyle(part);
          let duration = parseFloat(style.transitionDuration) * 1000;
          if (isNaN(duration) || duration <= 0) duration = 400;

          part.style.opacity = 0;
          setTimeout(() => {
            updateFn();
            part.style.opacity = 1;
          }, duration);
        };

        if (area === 'icon') {
          const current = part.firstElementChild;
          const isImagePath = typeof content === 'string' && (content.includes('/') || content.includes('.'));
          let hasChanged = false;
          if (isImagePath) {
            hasChanged = !current || current.tagName !== 'IMG' || current.getAttribute('src') !== content;
          } else {
            hasChanged = !current || current.tagName !== 'HA-ICON' || current.getAttribute('icon') !== content;
          }

          if (hasChanged) {
            if (shouldAnimate) {
              applyUpdate(() => this._updateIcon(part, content));
            } else {
              this._updateIcon(part, content);
            }
          } else {
            this._updateIcon(part, content);
          }
        } else {
          if (part.innerHTML !== String(content)) {
            if (shouldAnimate) {
              applyUpdate(() => { part.innerHTML = String(content); });
            } else {
              part.innerHTML = String(content);
            }
          }
        }
      }
    });
    this._isInitialContentLoaded = true;
  }

  _updateIcon(element, iconValue) {
    const current = element.firstElementChild;
    const isImagePath = typeof iconValue === "string" && (iconValue.includes("/") || iconValue.includes("."));
    if (isImagePath) {
      if (current?.tagName !== "IMG" || current.getAttribute("src") !== iconValue) {
        element.innerHTML = `<img src="${iconValue}" class="built-in-element" alt="">`;
      }
    } else {
      const wantSize = element.dataset.mdiSize || "";
      const needCreate = current?.tagName !== "HA-ICON" || current.getAttribute("icon") !== iconValue;
      if (needCreate) {
        const sizeStyle = wantSize ? `style="--mdc-icon-size:${wantSize};width:${wantSize};height:${wantSize};"` : "";
        element.innerHTML = `<ha-icon icon="${iconValue}" class="built-in-element" ${sizeStyle}></ha-icon>`;
      } else if (wantSize && current) {
        current.style.setProperty("--mdc-icon-size", wantSize);
        current.style.width = wantSize;
        current.style.height = wantSize;
      }
    }
  }

  /* ================== Actions & Confirm ================== */
  _handleTap(e) {
    const item = e.composedPath().find(n => n?.classList?.contains?.("grid-item"));
    if (!item) return;
    const key = item.dataset.area;
    const cfg = (this._finalConfig?.button_grid || {})[key] || {};

    // 二级确认
    const needConfirm = this._evaluateTemplate(cfg.confirm_dialog) === true;
    if (needConfirm) {
      const text = (cfg.confirm_dialog_content !== undefined)
        ? String(this._evaluateTemplate(cfg.confirm_dialog_content))
        : "确定要执行该操作吗？";

      // haptic
      this.dispatchEvent(new CustomEvent('haptic', {
        bubbles: true, composed: true, detail: 'heavy'
      }));

      this._showConfirm(text, () => this._executeTap(key, cfg), item);
      return;
    }

    this._executeTap(key, cfg);
  }

  _ensureGlobalConfirmLayer() {
    if (this._confirmRoot && document.body.contains(this._confirmRoot)) return;

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.style.position = "fixed";
    backdrop.style.inset = "0";
    backdrop.style.zIndex = "2147483000";
    backdrop.style.display = "none";
    backdrop.style.background = this._finalConfig.confirm_dialog_backdrop || "rgba(0,0,0,0.60)";
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) this._hideConfirm(); });

    // Dialog
    const dialog = document.createElement("div");
    dialog.style.position = "fixed";
    dialog.style.zIndex = "2147483001";    // 关键：高于遮罩
    dialog.style.minWidth = "220px";
    dialog.style.maxWidth = "80%";
    dialog.style.maxHeight = "70vh";
    dialog.style.overflow = "auto";
    dialog.style.background = "var(--card-background-color, #fff)";
    dialog.style.color = "var(--primary-text-color, #111)";
    dialog.style.borderRadius = "12px";
    dialog.style.boxShadow = "0 10px 30px rgba(0,0,0,.25)";
    dialog.style.padding = "14px 16px";
    dialog.style.boxSizing = "border-box";
    dialog.style.opacity = "0";
    dialog.style.transform = "translateY(6px)";
    dialog.style.transition = "transform 160ms ease, opacity 160ms ease";
    dialog.style.display = "none";         // 隐藏时真正不占位
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.addEventListener("click", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.textContent = "确认操作";
    title.style.fontWeight = "600";
    title.style.margin = "0 0 8px 0";
    title.style.fontSize = "15px";

    const content = document.createElement("div");
    content.textContent = "确定要执行该操作吗？";
    content.style.fontSize = "14px";
    content.style.margin = "0 0 12px 0";
    content.style.wordBreak = "break-word";
    this._confirmTextEl = content;

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";

    const btnCancel = document.createElement("button");
    btnCancel.textContent = "取消";
    btnCancel.style.appearance = "none";
    btnCancel.style.border = "0";
    btnCancel.style.borderRadius = "8px";
    btnCancel.style.padding = "8px 12px";
    btnCancel.style.cursor = "pointer";
    btnCancel.style.font = "inherit";
    btnCancel.style.background = "rgba(0,0,0,0.06)";
    btnCancel.addEventListener("click", () => this._hideConfirm());

    const btnOk = document.createElement("button");
    btnOk.textContent = "确定";
    btnOk.style.appearance = "none";
    btnOk.style.border = "0";
    btnOk.style.borderRadius = "8px";
    btnOk.style.padding = "8px 12px";
    btnOk.style.cursor = "pointer";
    btnOk.style.font = "inherit";
    btnOk.style.background = "var(--primary-color, #03a9f4)";
    btnOk.style.color = "#fff";
    btnOk.addEventListener("click", () => {
      const fn = this._pendingConfirm;
      this._hideConfirm();
      if (typeof fn === "function") fn();
    });

    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    dialog.appendChild(title);
    dialog.appendChild(content);
    dialog.appendChild(actions);

    document.body.appendChild(backdrop);
    document.body.appendChild(dialog);

    this._confirmRoot = backdrop;
    this._confirmDialogEl = dialog;
  }

  _showConfirm(text, onOk, anchorEl) {
    this._ensureGlobalConfirmLayer();

    this._pendingConfirm = onOk;
    this._confirmTextEl.textContent = text || "确定要执行该操作吗？";
    this._confirmAnchorEl = anchorEl || null;

    // 先显示遮罩与对话框
    this._confirmRoot.style.display = "block";
    const dlg = this._confirmDialogEl;
    dlg.style.display = "block";
    dlg.style.opacity = "0";
    dlg.style.transform = "translateY(6px)";
    dlg.style.left = "0px";
    dlg.style.top = "0px";

    // 定位并入场
    this._positionConfirmNear();
    requestAnimationFrame(() => {
      dlg.style.opacity = "1";
      dlg.style.transform = "translateY(0)";
    });

    this._bindRepositionEvents();
    this._confirmShown = true;
  }

  _hideConfirm() {
    if (!this._confirmRoot || !this._confirmShown) return;
    const dlg = this._confirmDialogEl;
    dlg.style.transform = "translateY(6px)";
    dlg.style.opacity = "0";
    // 动画后真正隐藏
    setTimeout(() => {
      if (this._confirmRoot) this._confirmRoot.style.display = "none";
      if (dlg) dlg.style.display = "none";
    }, 160);
    this._pendingConfirm = null;
    this._confirmShown = false;
    this._confirmAnchorEl = null;
    this._unbindRepositionEvents();
  }

  _teardownConfirmLayer() {
    this._unbindRepositionEvents();
    if (this._confirmDialogEl && this._confirmDialogEl.parentNode === document.body) {
      this._confirmDialogEl.remove();
    }
    if (this._confirmRoot && this._confirmRoot.parentNode === document.body) {
      this._confirmRoot.remove();
    }
    this._confirmRoot = null;
    this._confirmDialogEl = null;
    this._confirmTextEl = null;
    this._pendingConfirm = null;
    this._confirmShown = false;
    this._confirmAnchorEl = null;
  }

  _bindRepositionEvents() {
    if (this._repositionHandler) return;
    this._repositionHandler = () => {
      if (!this._confirmShown) return;
      if (this._repositionRAF) cancelAnimationFrame(this._repositionRAF);
      this._repositionRAF = requestAnimationFrame(() => this._positionConfirmNear());
    };
    window.addEventListener("resize", this._repositionHandler, { passive: true });
    window.addEventListener("scroll", this._repositionHandler, { passive: true, capture: true });
  }

  _unbindRepositionEvents() {
    if (!this._repositionHandler) return;
    window.removeEventListener("resize", this._repositionHandler, { capture: false });
    window.removeEventListener("scroll", this._repositionHandler, { capture: true });
    this._repositionHandler = null;
    if (this._repositionRAF) cancelAnimationFrame(this._repositionRAF), this._repositionRAF = 0;
  }

  /**
   * 将确认对话框吸附在触发按钮附近，避免重叠，并保持完全在视口内。
   * 方向优先级：下（默认）> 上 > 右 > 左；若都放不下，选空间最大方向并夹紧。
   */
  _positionConfirmNear() {
    const dlg = this._confirmDialogEl;
    const anchor = this._confirmAnchorEl;
    if (!dlg) return;

    const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    const MARGIN = 8;    // 视口边缘留白
    const GAP = 12;      // 与按钮间距

    const dW = dlg.offsetWidth;
    const dH = dlg.offsetHeight;

    let left = (vw - dW) / 2;
    let top  = (vh - dH) / 2;

    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();

      const spaceTop = r.top - MARGIN;
      const spaceBottom = vh - r.bottom - MARGIN;
      const spaceLeft = r.left - MARGIN;
      const spaceRight = vw - r.right - MARGIN;

      // 能完全容纳？
      const canBottom = dH + GAP <= spaceBottom;
      const canTop    = dH + GAP <= spaceTop;
      const canRight  = dW + GAP <= spaceRight;
      const canLeft   = dW + GAP <= spaceLeft;

      // 按优先级选择方向：下 > 上 > 右 > 左
      let placement = null;
      if (canBottom || canTop || canRight || canLeft) {
        if (canBottom) placement = "bottom";
        else if (canTop) placement = "top";
        else if (canRight) placement = "right";
        else placement = "left";
      } else {
        // 都放不下，选空间最大的方向
        const spaces = [
          ["bottom", spaceBottom],
          ["top", spaceTop],
          ["right", spaceRight],
          ["left", spaceLeft],
        ].sort((a,b)=>b[1]-a[1]);
        placement = spaces[0][0];
      }

      if (placement === "bottom") {
        top = Math.min(vh - dH - MARGIN, r.bottom + GAP);
        left = r.left + (r.width - dW) / 2;
        dlg.style.transform = "translateY(-6px)";
      } else if (placement === "top") {
        top = Math.max(MARGIN, r.top - GAP - dH);
        left = r.left + (r.width - dW) / 2;
        dlg.style.transform = "translateY(6px)";
      } else if (placement === "right") {
        left = Math.min(vw - dW - MARGIN, r.right + GAP);
        top = r.top + (r.height - dH) / 2;
        dlg.style.transform = "translateX(-6px)";
      } else { // left
        left = Math.max(MARGIN, r.left - GAP - dW);
        top = r.top + (r.height - dH) / 2;
        dlg.style.transform = "translateX(6px)";
      }

      // 夹紧到视口内
      left = Math.min(Math.max(left, MARGIN), vw - dW - MARGIN);
      top  = Math.min(Math.max(top , MARGIN), vh - dH - MARGIN);
    }

    dlg.style.left = `${Math.round(left)}px`;
    dlg.style.top  = `${Math.round(top)}px`;
  }

  _executeTap(key, cfg) {
    if (!key) return;

    clearTimeout(this._highlightRollbackTimer);
    clearTimeout(this._contentUpdateTimer);

    this._isUpdatingOptimistically = true;
    this._optimisticHighlightKey = key;

    this._allowAnimation = true;
    this._scheduleMove();

    this._contentUpdateTimer = setTimeout(() => {
      this._isUpdatingOptimistically = false;
      this._applyButtonContent();
    }, 300);

    this._highlightRollbackTimer = setTimeout(() => {
      this._optimisticHighlightKey = null;
      this._updateHighlightTarget();
    }, this._syncStateDelay);

    const rawAction = cfg.tap_action || this._finalConfig.tap_action;
    if (!rawAction || !this._hass) return;

    const actionConfig = this._evaluateActionConfig(rawAction);
    if (actionConfig?.action === "none") return;

    const dispatch = (eventName, detail) => {
      this.dispatchEvent(new CustomEvent(eventName, { bubbles: true, composed: true, detail }));
    };

    const entityIdForAction =
      actionConfig.entity ||
      (actionConfig.target && actionConfig.target.entity_id) ||
      cfg.entity ||
      this._finalConfig.entity;

    let action = actionConfig.action;
    if (action === "perform-action" && actionConfig.perform_action) {
      action = "call-service";
    } else if (action && action.includes(".") && !["call-service", "more-info"].includes(action)) {
      action = "call-service";
    }

    switch (action) {
      case "more-info":
        if (!entityIdForAction) return console.warn("grid-button-card: more-info 未找到 entity。");
        dispatch("hass-more-info", { entityId: entityIdForAction });
        break;
      case "toggle":
        if (!entityIdForAction) return console.warn("grid-button-card: toggle 未找到 entity。");
        this._hass.callService("homeassistant", "toggle", { entity_id: entityIdForAction });
        break;
      case "call-service": {
        const serviceCall = actionConfig.action.includes(".")
          ? actionConfig.action
          : actionConfig.service || actionConfig.perform_action;
        if (!serviceCall) {
          console.warn('grid-button-card: "call-service" 缺少 service 定义。');
          return;
        }
        const [domain, service] = serviceCall.split(".", 2);
        const serviceData = { ...(actionConfig.target || {}), ...(actionConfig.data || {}), ...(actionConfig.service_data || {}) };
        this._hass.callService(domain, service, serviceData);
        break;
      }
      case "navigate":
        if (!actionConfig.navigation_path) return console.warn('grid-button-card: "navigate" 缺少 navigation_path。');
        dispatch("hass-navigate", { path: actionConfig.navigation_path });
        break;
      case "url":
        if (!actionConfig.url_path) return console.warn('grid-button-card: "url" 缺少 url_path。');
        window.open(actionConfig.url_path, "_blank", "noopener");
        break;
      default:
        console.warn(`grid-button-card: 未处理的 action: ${actionConfig.action}`);
    }
  }

  /* ================== Highlight ================== */
  _updateHighlightTarget() {
    const newKey = this._calcHighlightKey();
    if (newKey !== this._highlightKey) this._highlightKey = newKey;
    this._scheduleMove();
  }

  _calcHighlightKey() {
    let top = this._finalConfig?.sync_state;
    top = this._evaluateTemplate(top);
    if (top === undefined || top === null || top === "") return "";
    const btns = this._finalConfig?.button_grid || {};
    for (const k of Object.keys(btns)) {
      let child = btns[k]?.sync_state;
      child = this._evaluateTemplate(child);
      if (child === top) return String(k);
    }
    return "";
  }

  _scheduleMove(doubleFrame = false) {
    if (this._rafMove) cancelAnimationFrame(this._rafMove);
    this._rafMove = requestAnimationFrame(() => {
      if (doubleFrame) requestAnimationFrame(() => this._moveHighlight(true));
      else this._moveHighlight();
    });
  }

  _moveHighlight() {
    const newKey = this._optimisticHighlightKey || this._highlightKey;
    const oldKey = this._lastTarget.key;
    const wrapper = this.shadowRoot?.querySelector(".grid-container");
    if (!wrapper) return;

    if (!this._hlEl) {
      this._hlEl = document.createElement("div");
      this._hlEl.className = "gbc-highlight";
      wrapper.appendChild(this._hlEl);
    }

    if (newKey !== oldKey) {
      if (oldKey) {
        const escOld = (window.CSS?.escape ? CSS.escape(oldKey) : oldKey.replace(/"/g, '\\"'));
        const oldBtn = this.shadowRoot.querySelector(`.btn[data-key="${escOld}"]`);
        if (oldBtn) oldBtn.style.backgroundColor = oldBtn.dataset.originalBg || "";
      }
      if (newKey) {
        const escNew = (window.CSS?.escape ? CSS.escape(newKey) : newKey.replace(/"/g, '\\"'));
        const newBtn = this.shadowRoot.querySelector(`.btn[data-key="${escNew}"]`);
        if (newBtn) newBtn.style.backgroundColor = "transparent";
      }
    }

    if (!newKey) {
      this._hlEl.style.opacity = "0";
      this._lastTarget.key = "";
      return;
    }

    const esc = (window.CSS?.escape ? CSS.escape(newKey) : newKey.replace(/"/g, '\\"'));
    const gridItem = this.shadowRoot?.querySelector(`.grid-item[data-area="${esc}"]`);
    const btn = this.shadowRoot?.querySelector(`.btn[data-key="${esc}"]`);
    if (!gridItem || !btn) {
      if (this._measureRetryCount < this._measureRetryMax) {
        this._measureRetryCount++;
        this._scheduleMove(true);
      }
      return;
    }

    const color = btn.dataset.highlightColor || "rgba(0, 150, 255, 0.18)";

    const targetX = gridItem.offsetLeft;
    const targetY = gridItem.offsetTop;
    const targetW = gridItem.offsetWidth;
    const targetH = gridItem.offsetHeight;

    const cs = getComputedStyle(btn);
    this._hlEl.style.borderTopLeftRadius     = cs.borderTopLeftRadius;
    this._hlEl.style.borderTopRightRadius    = cs.borderTopRightRadius;
    this._hlEl.style.borderBottomRightRadius = cs.borderBottomRightRadius;
    this._hlEl.style.borderBottomLeftRadius  = cs.borderBottomLeftRadius;

    const rects = (this.shadowRoot.host && this.shadowRoot.host.getClientRects) ? this.shadowRoot.host.getClientRects() : [];
    const hostInvisible = (rects.length === 0) || wrapper.offsetWidth === 0 || wrapper.offsetHeight === 0;
    const needRetry = hostInvisible || targetW <= 0 || targetH <= 0;
    if (needRetry) {
      if (this._measureRetryCount < this._measureRetryMax) {
        this._measureRetryCount++;
        this._scheduleMove(true);
      } else {
        this._measureRetryCount = 0;
      }
      return;
    }

    this._measureRetryCount = 0;

    const { key: lastKey, x, y, w, h, color: lastColor } = this._lastTarget;
    if (
      lastKey === newKey &&
      Math.abs(targetX - x) < 1 && Math.abs(targetY - y) < 1 &&
      Math.abs(targetW - w) < 1 && Math.abs(targetH - h) < 1 &&
      lastColor === color
    ) return;

    this._lastTarget = { key: newKey, x: targetX, y: targetY, w: targetW, h: targetH, color };

    const useAnimation = this._allowAnimation && this._firstShown;
    if (this._allowAnimation) this._allowAnimation = false;

    if (!this._firstShown || !useAnimation) this._hlEl.style.transition = 'none';

    this._hlEl.style.opacity = '1';
    this._hlEl.style.left = `${targetX}px`;
    this._hlEl.style.top = `${targetY}px`;
    this._hlEl.style.width = `${targetW}px`;
    this._hlEl.style.height = `${targetH}px`;
    this._hlEl.style.backgroundColor = color;

    if (!this._firstShown) this._firstShown = true;

    if (!useAnimation) {
      requestAnimationFrame(() => { if (this._hlEl) this._hlEl.style.transition = ''; });
    }
  }

  /* ================== Template & Helpers ================== */
  _evaluateTemplate(value) {
    if (typeof value !== "string") return value;
    const s = value.trim();
    if (!s.startsWith("[[[") || !s.endsWith("]]]")) return value;
    if (!this._hass) return "";

    const _exec = (codeStr, variablesProxy) => {
      const hass = this._hass;
      const states = hass?.states || {};
      const user = hass?.user;
      const entityId = this._finalConfig?.entity;
      const entity = entityId ? states[entityId] : null;
      const isBlock = /(\bvar\b|\bif\b|\blet\b|\bconst\b|;|\n|\breturn\b)/.test(codeStr);
      if (isBlock) {
        return Function("hass","states","entity","user","variables","config","card",
          `"use strict"; ${codeStr}`)(hass, states, entity, user, variablesProxy, this._finalConfig, this);
      }
      return Function("hass","states","entity","user","variables","config","card",
        `"use strict"; return (${codeStr})`)(hass, states, entity, user, variablesProxy, this._finalConfig, this);
    };

    try {
      const rawCode = s.slice(3, -3);
      const variablesProxy = new Proxy(this._variables || {}, {
        get: (target, property, receiver) => {
          const val = Reflect.get(target, property, receiver);
          if (typeof val === "string" && val.trim().startsWith("[[[") && val.trim().endsWith("]]]")) {
            const inner = val.trim().slice(3, -3);
            return _exec(inner, variablesProxy);
          }
          return val;
        }
      });
      return _exec(rawCode, variablesProxy);
    } catch (e) {
      console.error("grid-button-card: 模板错误", value, e);
      return "";
    }
  }

  _evaluateActionConfig(config) {
    if (config === null || typeof config !== "object") return this._evaluateTemplate(config);
    if (Array.isArray(config)) return config.map(item => this._evaluateActionConfig(item));
    const out = {};
    for (const k in config) if (Object.prototype.hasOwnProperty.call(config, k)) out[k] = this._evaluateActionConfig(config[k]);
    return out;
  }

  _arrayStylesToString(arr) {
    if (!Array.isArray(arr)) return "";
    let cssText = "";
    arr.forEach((obj) => {
      if (typeof obj !== "object" || obj === null) return;
      for (const [key, raw] of Object.entries(obj)) {
        const val = this._evaluateTemplate(raw);
        if (val !== undefined && val !== null && String(val) !== "") cssText += `${key}: ${val};`;
      }
    });
    return cssText;
  }

  _normalizeTopGridStyles(list) {
    if (!Array.isArray(list)) return "";
    const raw = list.slice();

    const getVal = (prop) => {
      const line = raw.find(s => typeof s === "object" && s && s[prop] !== undefined);
      return line ? String(this._evaluateTemplate(line[prop])) : null;
    };

    const hasTemplate = raw.some(s => typeof s === "object" && s && s["grid-template"] !== undefined);
    const areas = getVal("grid-template-areas");
    const cols = getVal("grid-template-columns");
    const rows = getVal("grid-template-rows");

    let css = "";

    if (hasTemplate) {
      css += this._arrayStylesToString(list);
    } else if (areas) {
      const gridTemplate = `grid-template: ${areas}${cols ? ` / ${cols}` : ""};`;
      const others = list.filter(s => !(typeof s === "object" && s && (
        s["grid-template"] !== undefined ||
        s["grid-template-areas"] !== undefined ||
        s["grid-template-columns"] !== undefined ||
        s["grid-template-rows"] !== undefined
      )));
      css += gridTemplate + this._arrayStylesToString(others);
    } else if (rows || cols) {
      const gridTemplate = `grid-template: ${rows || "auto"} / ${cols || "auto"};`;
      const others = list.filter(s => !(typeof s === "object" && s && (
        s["grid-template"] !== undefined ||
        s["grid-template-areas"] !== undefined ||
        s["grid-template-columns"] !== undefined ||
        s["grid-template-rows"] !== undefined
      )));
      css += gridTemplate + this._arrayStylesToString(others);
    } else {
      css += this._arrayStylesToString(list);
    }

    if (!/display\s*:\s*grid/i.test(css)) css = `display: grid;${css}`;
    return css;
  }

  static _deepClone(obj) {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(x => GridButtonCard._deepClone(x));
    const out = {};
    for (const k of Object.keys(obj)) out[k] = GridButtonCard._deepClone(obj[k]);
    return out;
  }

  static _deepMerge(base, ext) {
    if (base === null || typeof base !== "object") return GridButtonCard._deepClone(ext);
    if (ext === null || typeof ext !== "object") return GridButtonCard._deepClone(base);
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (Array.isArray(base) && Array.isArray(ext)) return base.concat(ext);
    for (const k of Object.keys(ext)) {
      const bv = out[k], ev = ext[k];
      if (Array.isArray(bv) && Array.isArray(ev)) out[k] = bv.concat(ev);
      else if (bv && typeof bv === "object" && ev && typeof ev === "object") out[k] = GridButtonCard._deepMerge(bv, ev);
      else out[k] = GridButtonCard._deepClone(ev);
    }
    return out;
  }

  static _getGlobalTemplates() {
    try {
      const ha = document.querySelector("home-assistant");
      const main = ha?.shadowRoot?.querySelector("home-assistant-main");
      const panel = main?.shadowRoot?.querySelector("ha-panel-lovelace");
      const cfg = panel?.lovelace?.config;
      return cfg?.grid_button_card_templates || cfg?.button_card_templates || {};
    } catch (e) { return {}; }
  }

  _resolveTemplatesAndVariables(inputCfg) {
    const globalTpl = GridButtonCard._getGlobalTemplates();
    const tplEntries = [];
    const pushByName = (name) => {
      if (!name || typeof name !== "string") return;
      const def = globalTpl[name];
      if (!def) { console.warn("[grid-button-card] 未找到模板:", name); return; }
      tplEntries.push({ name, def });
    };

    const rawTemplate = inputCfg.template ?? inputCfg.templates;
    if (rawTemplate) {
      if (typeof rawTemplate === "string") pushByName(rawTemplate);
      else if (Array.isArray(rawTemplate)) rawTemplate.forEach(pushByName);
    }

    const visited = new Set();
    const unfold = (tplDef) => {
      const name = Object.entries(globalTpl).find(([k, v]) => v === tplDef)?.[0];
      if (name) {
        if (visited.has(name)) { console.warn("[grid-button-card] 模板循环：", name); return {}; }
        visited.add(name);
      }
      let merged = {};
      const parentRef = tplDef?.template ?? tplDef?.templates;
      if (parentRef) {
        const parents = Array.isArray(parentRef) ? parentRef : [parentRef];
        for (const p of parents) {
          const pd = globalTpl[p];
          if (!pd) { console.warn("[grid-button-card] 模板未找到（父）：", p); continue; }
          merged = GridButtonCard._deepMerge(merged, unfold(pd));
        }
      }
      merged = GridButtonCard._deepMerge(merged, tplDef || {});
      return merged;
    };

    let mergedCfg = {};
    for (const { def } of tplEntries) mergedCfg = GridButtonCard._deepMerge(mergedCfg, unfold(def));

    const tplVars = mergedCfg.variables || {};
    const userVars = inputCfg.variables || {};
    const finalVars = GridButtonCard._deepMerge(tplVars, userVars);

    const { template, templates, variables, ...restInput } = inputCfg;
    const finalCfg = GridButtonCard._deepMerge(mergedCfg, restInput);

    return { finalCfg, finalVars };
  }

  getCardSize() { return this._finalConfig?.card_size || 3; }
}

if (!customElements.get("grid-button-card")) {
  customElements.define("grid-button-card", GridButtonCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "grid-button-card",
    name: "Grid Button Card v1.1.0",
    description: "Grid Button Card 是一个高度可定制的 Lovelace 卡片，它允许您在一个卡片内创建灵活的按钮网格布局",
  });
}
