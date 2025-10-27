// v1.0.1
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

        // —— NEW: 视图切换与测量稳态相关 —— 
    this._rafMove = 0;                 // 合并/取消重复 _scheduleMove
    this._measureRetryCount = 0;       // 当前测量重试计数
    this._measureRetryMax = 60;        // 最多 60 帧（≈1s）rAF 重试
    this._viewMo = null;               // 观察所属 view 的 MutationObserver
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
      if (this._isUpdatingOptimistically) {
        return;
      }

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

  /* ================== Structure (No changes) ================== */

  _render() {
    const style = document.createElement("style");
    style.textContent = `
      .grid-container { display: grid; width: 100%; position: relative; }
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

      .gbc-highlight {
        position: absolute;
        top: 0; left: 0;
        z-index: 1;
        pointer-events: none;
        border-radius: var(--gbc-radius, 10px);
        opacity: 1;
        transform-origin: top left;
        transition: transform 500ms cubic-bezier(0.2, 0.9, 0.2, 1),
                    background-color 320ms ease,
                    border-radius 320ms ease,
                    opacity 320ms ease;
        will-change: transform, background-color;
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
    // —— NEW: 监听所属 HA 视图从隐藏→可见 —— 
    const findViewHost = () => {
      // hui-view 或 hui-panel-view（不同主题/版本命名略有差异）
      let n = this;
      const getHost = (x) => (x && x.getRootNode && x.getRootNode() instanceof ShadowRoot) ? x.getRootNode().host : null;
      while (n) {
        if (n.tagName && /^(HUI-|HOMECARD-|STACK-IN-CARD)/i.test(n.tagName)) break;
        const host = getHost(n);
        n = n.parentNode || host;
      }
      // 继续向上找 hui-view / hui-panel-view
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
        // 视图任何属性变化（尤其是 hidden/style.display）后，给两帧再重算
        this._measureRetryCount = 0;
        this._scheduleMove(/*doubleFrame*/ true);
      });
      this._viewMo.observe(view, { attributes: true, attributeFilter: ["hidden", "style", "class"] });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    this._resizeObserver?.disconnect();
    this._viewMo?.disconnect?.();   // NEW
    this._viewMo = null;            // NEW
    if (this._rafMove) cancelAnimationFrame(this._rafMove), this._rafMove = 0; // NEW
    window.removeEventListener("resize", this._onResizeRef);
    clearTimeout(this._highlightRollbackTimer);
    clearTimeout(this._contentUpdateTimer);
  }


  _mountButtons() {
    const wrapper = this.shadowRoot.querySelector(".grid-container");
    if (!wrapper) return;

    wrapper.innerHTML = "";

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

  /* ================== Styles (No changes) ================== */
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

  /* ================== Content (No changes) ================== */
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
          if (isNaN(duration) || duration <= 0) {
            duration = 400;
          }

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

  /* ================== Actions (No changes) ================== */
  _handleTap(e) {
    const item = e.composedPath().find(n => n?.classList?.contains?.("grid-item"));
    if (!item) return;
    const key = item.dataset.area;
    const cfg = (this._finalConfig?.button_grid || {})[key] || {};

    if (key) {
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
    }

    const rawAction = cfg.tap_action || this._finalConfig.tap_action;
    if (!rawAction || !this._hass) return;

    const actionConfig = this._evaluateActionConfig(rawAction);
    if (actionConfig.action === "none") return;

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
    if (newKey !== this._highlightKey) {
      this._highlightKey = newKey;
    }
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
      if (doubleFrame) {
        requestAnimationFrame(() => this._moveHighlight(/*fromDouble*/ true));
      } else {
        this._moveHighlight();
      }
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
      this._hlEl.style.transform = "scale(0)";
      this._lastTarget.key = "";
      return;
    }

    const esc = (window.CSS?.escape ? CSS.escape(newKey) : newKey.replace(/"/g, '\\"'));
    const gridItem = this.shadowRoot?.querySelector(`.grid-item[data-area="${esc}"]`);
    const btn = this.shadowRoot?.querySelector(`.btn[data-key="${esc}"]`);
    
    if (!gridItem || !btn) {
    // 不隐藏；多半是刚切回还没渲染到 DOM
    if (this._measureRetryCount < this._measureRetryMax) {
      this._measureRetryCount++;
      this._scheduleMove(/*doubleFrame*/ true);
    }
    return;
  }

    const color = btn.dataset.highlightColor || "rgba(0, 150, 255, 0.18)";

    // 🔑 核心修复: 使用 offsetLeft/Top/Width/Height 替代 getBoundingClientRect()
    // 这可以获取相对于父容器的、不受 transform 影响的稳定布局坐标。
    const targetX = gridItem.offsetLeft;
    const targetY = gridItem.offsetTop;
    const targetW = gridItem.offsetWidth;
    const targetH = gridItem.offsetHeight;

    // 读取目标按钮的“真实”圆角并同步到高亮层1
    const cs = getComputedStyle(btn);
    this._hlEl.style.borderTopLeftRadius     = cs.borderTopLeftRadius;
    this._hlEl.style.borderTopRightRadius    = cs.borderTopRightRadius;
    this._hlEl.style.borderBottomRightRadius = cs.borderBottomRightRadius;
    this._hlEl.style.borderBottomLeftRadius  = cs.borderBottomLeftRadius;

    // —— NEW: 不可见/零尺寸时，不隐藏高亮；用 rAF 必达式重试直到成功 —— 
    const hostInvisible = !this.offsetParent || this.offsetWidth === 0 || this.offsetHeight === 0;
    const needRetry = hostInvisible || targetW <= 0 || targetH <= 0;

    if (needRetry) {
      // 保持现有高亮（不要把它缩没/opacity=0），避免“直接没高亮”的观感
      if (this._measureRetryCount < this._measureRetryMax) {
        this._measureRetryCount++;
        this._scheduleMove(/*doubleFrame*/ true); // 下一帧继续尝试测量
      } else {
        // 超过上限：作为兜底，仍然不隐藏；下次 states/resize 会把它拉回
        this._measureRetryCount = 0;
      }
      return;
    }

    // 一旦拿到有效尺寸，清零计数
    this._measureRetryCount = 0;


    const { key: lastKey, x, y, w, h, color: lastColor } = this._lastTarget;
    if (
      lastKey === newKey &&
      Math.abs(targetX - x) < 1 && Math.abs(targetY - y) < 1 &&
      Math.abs(targetW - w) < 1 && Math.abs(targetH - h) < 1 &&
      lastColor === color
    ) {
      return;
    }

    this._lastTarget = { key: newKey, x: targetX, y: targetY, w: targetW, h: targetH, color };
    
    const useAnimation = this._allowAnimation && this._firstShown;
    if (this._allowAnimation) this._allowAnimation = false;

    if (!this._firstShown || !useAnimation) {
      this._hlEl.style.transition = 'none';
    }

    this._hlEl.style.opacity = '1';
    this._hlEl.style.transform = `translate(${targetX}px, ${targetY}px)`;
    this._hlEl.style.width = `${targetW}px`;
    this._hlEl.style.height = `${targetH}px`;
    this._hlEl.style.backgroundColor = color;

    if (!this._firstShown) this._firstShown = true;

    if (!useAnimation) {
      requestAnimationFrame(() => {
        if (this._hlEl) this._hlEl.style.transition = '';
      });
    }
  }

  /* ================== Template & Helpers (No changes) ================== */
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
    name: "Grid Button Card v1.0.1",
    description: "Grid Button Card 是一个高度可定制的 Lovelace 卡片，它允许您在一个卡片内创建灵活的按钮网格布局",
  });
}
