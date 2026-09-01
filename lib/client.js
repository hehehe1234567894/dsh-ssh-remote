/**
 * deepseek-harness-ssh — browser half (client bundle).
 *
 * v1.3.0 adds two UI pieces on top of the settings card:
 *   1. 目标切换 chip — injected right next to the composer's permission
 *      selector ("Workspace Write") via DOM (rc.7 declares no plugin slot
 *      there). Reorders `connections` through this plugin's own endpoint,
 *      so the FIRST connection = the tools' default target. Live effect,
 *      no DSH restart needed.
 *   2. 远程文件夹选择 — a small directory browser (endpoint method
 *      `browse`, host v1.3.0+) that stores a connection's `defaultCwd`.
 *      Feature-detected: while the running host is still v1.2.0 the UI
 *      shows a "重启 DSH 后可用" hint instead of breaking.
 *
 * Hand-written in the ModuleLoader bundle format; does NOT modify DSH core.
 */
window.__ModuleLoader__.load({
  id: "deepseek-harness-ssh",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useState } = React;

    const NS = "deepseek-harness-ssh";

    /* ------------------------------------------------------- card fields */
    const CONN_FIELDS = [
      { key: "name", label: "连接名", type: "text", hint: "给这台机器起个名字，工具里用 target=名字 选择。", required: true },
      { key: "host", label: "主机 host", type: "text", hint: "反向隧道填 127.0.0.1（云端转发口）；Tailscale 填 100.x.x.x。", required: true },
      { key: "port", label: "端口", type: "number", hint: "隧道口（如 2222）或远程 sshd 端口（一般 22）。" },
      { key: "user", label: "登录用户名", type: "text", hint: "Windows 是 C:\\Users\\ 下的名字。", required: true },
      { key: "identityFile", label: "私钥", type: "text", hint: "默认 ~/.ssh/dsh_cloud_to_home。" },
      { key: "defaultShell", label: "远程 Shell", type: "select", options: [["powershell", "powershell（Windows）"], ["bash", "bash（Linux / macOS）"]], hint: "Windows 选 powershell。" },
      { key: "defaultCwd", label: "起始目录", type: "text", hint: "工具未指定目录时的默认位置（如 D:\\projects）；重启 DSH 后生效。" },
    ];

    function newConnection(seed) {
      return {
        name: (seed && seed.name) || "",
        host: (seed && seed.host) || "",
        port: (seed && seed.port) || 22,
        user: (seed && seed.user) || "",
        identityFile: (seed && seed.identityFile) || "~/.ssh/dsh_cloud_to_home",
        defaultShell: (seed && seed.defaultShell) || "powershell",
        defaultCwd: (seed && seed.defaultCwd) || "",
      };
    }

    function pickConnections(d) {
      const list = Array.isArray(d && d.connections) ? d.connections : [];
      return list.map((c) => newConnection(c));
    }

    /* ----------------------------------------------------------- tiny DOM */
    function el(tag, attrs) {
      const node = document.createElement(tag);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (k === "class") node.className = v;
          else if (k === "text") node.textContent = v;
          else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
          else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
          else if (v !== undefined && v !== null) node.setAttribute(k, v);
        }
      }
      for (let i = 2; i < arguments.length; i++) {
        const kid = arguments[i];
        if (kid === null || kid === undefined) continue;
        node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
      }
      return node;
    }

    /* ------------------------------------------------------------- styles */
    let cssReady = false;
    function ensureCss() {
      if (cssReady || typeof document === "undefined") return;
      const tagId = NS + "/settings";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) { cssReady = true; return; }
      const tag = document.createElement("style");
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = tagId;
      tag.textContent = [
        /* ---- settings card ---- */
        ".dsh-ssh-cfg{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;color:var(--dsw-alias-label-primary,inherit)}",
        ".dsh-ssh-cfg-h{display:flex;align-items:center}",
        ".dsh-ssh-cfg-expand{appearance:none;display:flex;align-items:center;gap:8px;width:100%;font:inherit;color:inherit;text-align:left;background:0 0;border:0;border-radius:12px;padding:14px 16px;cursor:pointer}",
        ".dsh-ssh-cfg-expand:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}",
        ".dsh-ssh-cfg-t{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
        ".dsh-ssh-cfg-n{font-weight:600;font-size:15px;line-height:1.4}",
        ".dsh-ssh-cfg-d{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".dsh-ssh-badge{flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-state-warn-tertiary,#fff7ed);color:var(--dsw-alias-state-warn-label,#c2410c)}",
        ".dsh-ssh-badge.ok{background:var(--dsw-alias-state-success-tertiary,#ecfdf5);color:var(--dsw-alias-state-success-primary,#047857)}",
        ".dsh-ssh-cfg-b{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);padding:12px 16px 14px;display:flex;flex-direction:column;gap:12px}",
        ".dsh-ssh-conn{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}",
        ".dsh-ssh-conn-h{display:flex;align-items:center;gap:8px}",
        ".dsh-ssh-conn-title{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dsh-ssh-conn-del{appearance:none;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:0 0;color:var(--dsw-alias-state-error-primary,#dc2626);border-radius:6px;padding:2px 8px}",
        ".dsh-ssh-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}",
        ".dsh-ssh-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
        ".dsh-ssh-label{font-size:12px;font-weight:500}",
        ".dsh-ssh-input,.dsh-ssh-select{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,inherit);height:32px;border-radius:8px;padding:0 10px;font:inherit;font-size:13px;width:100%}",
        ".dsh-ssh-input:focus-visible,.dsh-ssh-select:focus-visible{border-color:var(--dsw-alias-brand-primary,#6366f1);outline:none}",
        ".dsh-ssh-hint{color:var(--dsw-alias-label-tertiary,#6b7280);margin:0;font-size:11px;line-height:1.45}",
        ".dsh-ssh-add{appearance:none;font:inherit;font-size:13px;cursor:pointer;border:1px dashed var(--dsw-alias-border-l2,#e5e7eb);background:0 0;color:var(--dsw-alias-label-secondary,#4b5563);border-radius:10px;padding:8px}",
        ".dsh-ssh-add:hover{border-color:var(--dsw-alias-brand-primary,#6366f1);color:var(--dsw-alias-label-primary,inherit)}",
        ".dsh-ssh-err{color:var(--dsw-alias-state-error-primary,#dc2626);margin:0;font-size:12px}",
        ".dsh-ssh-ok{color:var(--dsw-alias-state-success-primary,#047857);margin:0;font-size:12px}",
        ".dsh-ssh-actions{display:flex;justify-content:flex-end;gap:8px}",
        ".dsh-ssh-btn,.dsh-ssh-btn2{appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:5px 14px;border:1px solid transparent}",
        ".dsh-ssh-btn2{border-color:var(--dsw-alias-border-l2,#e5e7eb);background:0 0;color:var(--dsw-alias-label-secondary,#4b5563)}",
        ".dsh-ssh-btn{background:var(--dsw-alias-label-primary,#111827);color:var(--dsw-alias-bg-layer-3,#fff)}",
        ".dsh-ssh-btn:disabled,.dsh-ssh-btn2:disabled{opacity:.4;cursor:default}",
        /* ---- composer switcher chip ---- */
        ".dsh-ssh-chip{appearance:none;display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-secondary,#4b5563);border-radius:8px;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}",
        ".dsh-ssh-chip:hover{border-color:var(--dsw-alias-brand-primary,#6366f1);color:var(--dsw-alias-label-primary,inherit)}",
        ".dsh-ssh-pop{position:absolute;bottom:calc(100% + 8px);left:0;min-width:250px;max-width:330px;background:var(--dsw-alias-bg-layer-3,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;box-shadow:0 8px 28px rgba(15,23,42,.14);padding:8px;z-index:9999}",
        ".dsh-ssh-pop-t{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary,#6b7280);padding:2px 6px 6px}",
        ".dsh-ssh-pop-item{appearance:none;display:flex;align-items:center;gap:8px;width:100%;font:inherit;font-size:13px;text-align:left;background:0 0;border:0;border-radius:8px;padding:7px 8px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit)}",
        ".dsh-ssh-pop-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}",
        ".dsh-ssh-pop-item .nm{font-weight:600}",
        ".dsh-ssh-pop-item .ep{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}",
        ".dsh-ssh-pop-item .ck{color:var(--dsw-alias-state-success-primary,#047857);font-size:12px;flex:none;min-width:30px;text-align:right}",
        ".dsh-ssh-pop-ft{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);margin-top:6px;padding:8px 6px 2px;display:flex;flex-direction:column;gap:6px}",
        ".dsh-ssh-pop-note{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:1.5;margin:0}",
        /* ---- folder browser modal ---- */
        ".dsh-ssh-modal{position:fixed;inset:0;background:rgba(15,23,42,.35);display:flex;align-items:center;justify-content:center;z-index:10000}",
        ".dsh-ssh-modal-c{width:min(460px,92vw);height:min(560px,80vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:14px;padding:14px;gap:10px;overflow:hidden}",
        ".dsh-ssh-modal-t{font-size:14px;font-weight:600}",
        ".dsh-ssh-path-row{display:flex;gap:6px}",
        ".dsh-ssh-dirs{flex:1 1 0;overflow:auto;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;padding:4px;min-height:0}",
        ".dsh-ssh-dir{appearance:none;display:block;width:100%;font:inherit;font-size:13px;text-align:left;background:0 0;border:0;border-radius:8px;padding:7px 10px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit)}",
        ".dsh-ssh-dir:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}",
        /* ---- workspace directory flow (借鉴 dsh-remote) ---- */
        ".dsh-ssh-tabs{display:flex;gap:4px}",
        ".dsh-ssh-tab{appearance:none;font:inherit;font-size:13px;cursor:pointer;border:1px solid transparent;background:0 0;color:var(--dsw-alias-label-secondary,#4b5563);border-radius:8px;padding:5px 12px}",
        ".dsh-ssh-tab.on{border-color:var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,inherit);font-weight:600}",
        ".dsh-ssh-crumb{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280);word-break:break-all;min-height:16px}",
      ].join("");
      document.head.appendChild(tag);
      cssReady = true;
    }

    /* ----------------------------------------------------------- transport */
    function pluginUrl(path) {
      const suffix = String(path || "").replace(/^\/+/, "");
      const base = typeof document !== "undefined" ? document.baseURI : "/";
      return new URL("./ssh-remote" + (suffix ? "/" + suffix : ""), base).toString();
    }

    async function api(method, payload) {
      const res = await fetch(pluginUrl(""), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, ...payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || "HTTP " + res.status);
      return body;
    }

    /* ============================================ folder browser (v1.3+) === */
    function parentPath(base) {
      const trimmed = String(base || "").replace(/[\\/]+$/, "");
      const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
      if (idx < 0) return /^[A-Za-z]:$/.test(trimmed) ? trimmed + "\\" : trimmed; // 已在盘符根
      if (idx === 0) return trimmed.charAt(0) === "/" ? "/" : trimmed;            // POSIX 根
      const up = trimmed.slice(0, idx);
      return /^[A-Za-z]:$/.test(up) ? up + "\\" : up; // 盘符根统一补反斜杠
    }

    // 把 SSH 层错误翻译成可操作的人话
    function humanizeSshError(msg) {
      const m = String(msg || "");
      if (/exit 255/.test(m)) {
        if (/refused/i.test(m) || true) return m + " —— SSH 连不上：laptop 的隧道可能没运行（在电脑上重跑 tunnel.ps1），或远端 sshd 异常；稍等几秒再点“打开”重试";
        return m;
      }
      return m;
    }

    /* ================================= workspace directory flow (v1.3.1) === */
    // 纯远程模式（v1.4.0）：以 priority -100 填充 ui-workspace 的 directory-flow
    // 洞，统一选择目录。选远程电脑的目录时调用 set-workdir 把它存为该机器的
    // 默认工作目录 —— 项目完全留在远程电脑上，读写由 ssh_* 工具直接完成；
    // 选云端本机目录时仍然 onPicked(path) 交给 DSH 收养为本地工作区。
    function DirPicker({ open, busy, onPicked, onCancel }) {
      useEffect(() => ensureCss(), []);
      const [conns, setConns] = useState([]);
      const [machine, setMachine] = useState("");
      const [path, setPath] = useState("");
      const [dirs, setDirs] = useState(null);
      const [resolved, setResolved] = useState("");
      const [status, setStatus] = useState("");
      const [statusKind, setStatusKind] = useState("info");
      function flash(text, kind) { setStatus(text); setStatusKind(kind || "info"); }
      const [loading, setLoading] = useState(false);
      const [newName, setNewName] = useState("");
      const [creating, setCreating] = useState(false);

      useEffect(() => {
        if (!open) return;
        let live = true;
        api("config", {})
          .then((d) => {
            if (!live) return;
            const list = pickConnections(d);
            setConns(list);
            setMachine((m) => m || (list[0] && list[0].name) || "");
          })
          .catch(() => {});
        return () => { live = false; };
      }, [open]);

      // 打开弹窗或切换电脑时，自动列出当前目录（起始目录优先，否则用户主目录）
      useEffect(() => {
        if (!open || !machine) return;
        const seed = ((conns.find((c) => c.name === machine) || {}).defaultCwd) || ".";
        browse(seed);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, machine]);

      if (!open) return null;
      const current = conns.find((c) => c.name === machine);

      async function browse(p) {
        if (!current) { setStatus("请先选择一台电脑"); return; }
        setLoading(true);
        try {
          const d = await api("browse", { target: machine, path: p || "." });
          setDirs(d.dirs || []);
          setResolved(d.path || p || "");
          setPath(d.path || p || "");
          flash("", "info");
        } catch (e) {
          setDirs(null);
          const msg = e.message || String(e);
          flash(/unknown method|HTTP 404/i.test(msg) ? "远程浏览需重启 DSH（加载插件 v1.3.3）后可用" : "浏览失败：" + humanizeSshError(msg), "err");
        } finally {
          setLoading(false);
        }
      }

      async function makeDir() {
        const name = newName.trim();
        if (!name || loading) return;
        setCreating(true);
        flash("", "info");
        try {
          const d = await api("mkdir", { target: machine, path: resolved || path, name });
          if (d && d.ok) {
            setNewName("");
            flash("✅ 已创建 " + (d.path || name), "ok");
            await browse(resolved || path);
          } else {
            flash((d && d.error) || "创建失败", "err");
          }
        } catch (e) {
          const msg = e.message || String(e);
          flash(/unknown method|HTTP 404/i.test(msg) ? "新建文件夹需重启 DSH（加载插件 v1.3.3）后可用" : "创建失败：" + humanizeSshError(msg), "err");
        } finally {
          setCreating(false);
        }
      }

      const isLocalMachine = !!(current && current.host === "127.0.0.1" && Number(current.port) === 22);

      async function confirmRemote() {
        const target = resolved || path.trim();
        if (!target) { flash("请先浏览或输入远程目录", "err"); return; }
        if (isLocalMachine) { onPicked(target); return; } // 云端本机目录直接作为工作区
        flash("设置远程工作目录…", "info");
        try {
          const d = await api("set-workdir", { target: machine, path: target });
          if (d && d.ok) {
            flash("✅ 已在 " + machine + " 上以 " + target + " 作为工作目录。关闭后直接对话即可 —— 文件读写会直接发生在这台电脑上。", "ok");
            setTimeout(onCancel, 1200);
          } else {
            flash((d && d.error) || "设置失败", "err");
          }
        } catch (e) {
          const msg = e.message || String(e);
          flash(/unknown method|HTTP 404/i.test(msg) ? "设定工作目录需重启 DSH（加载插件 v1.4.0）后可用" : "设置失败：" + humanizeSshError(msg), "err");
        }
      }

      function pickRemoteDir(name) {
        const base = resolved || path.trim() || ".";
        const slash = base.includes("\\") ? "\\" : "/";
        const next = base.endsWith("\\") || base.endsWith("/") ? base + name : base + slash + name;
        browse(next);
      }

      const remoteBody = h("div", { style: { display: "flex", flexDirection: "column", gap: 8, flex: "1 1 0", minHeight: 0, overflow: "hidden" } },
        h("div", { className: "dsh-ssh-field" },
          h("span", { className: "dsh-ssh-label" }, "选择电脑"),
          h("select", {
            className: "dsh-ssh-select",
            value: machine,
            onChange: (event) => { setMachine(event.target.value); setDirs(null); setResolved(""); setStatus(""); },
          },
            conns.map((c) => h("option", { key: c.name, value: c.name }, (c.name || "(未命名)") + " — " + c.user + "@" + c.host + ":" + c.port)),
          ),
        ),
        h("div", { className: "dsh-ssh-path-row" },
          h("input", {
            className: "dsh-ssh-input",
            value: path,
            placeholder: "远程目录，如 D:\\projects 或 ~（回车打开）",
            onChange: (event) => setPath(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") browse(path); },
          }),
          h("button", { className: "dsh-ssh-btn2", type: "button", disabled: loading, onClick: () => browse(path) }, "打开"),
          h("button", { className: "dsh-ssh-btn2", type: "button", disabled: loading, onClick: () => browse(parentPath(resolved || path)) }, "上级"),
        ),
        h("div", { className: "dsh-ssh-crumb" }, resolved ? "当前: " + resolved : " "),
        h("div", { className: "dsh-ssh-dirs" },
          loading
            ? h("p", { className: "dsh-ssh-hint" }, "读取目录中…")
            : dirs === null
              ? h("p", { className: "dsh-ssh-hint" }, "正在准备目录列表…")
              : dirs.length === 0
                ? h("p", { className: "dsh-ssh-hint" }, "（没有子文件夹，可直接点“在此目录工作”，或用下方新建文件夹）")
                : dirs.map((name) => h("button", {
                    key: name, className: "dsh-ssh-dir", type: "button",
                    onClick: () => pickRemoteDir(name),
                  }, "📁 " + name)),
        ),
        h("div", { className: "dsh-ssh-path-row" },
          h("input", {
            className: "dsh-ssh-input",
            value: newName,
            placeholder: "新建文件夹名称",
            onChange: (event) => setNewName(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") makeDir(); },
          }),
          h("button", { className: "dsh-ssh-btn2", type: "button", disabled: creating || !newName.trim(), onClick: makeDir }, creating ? "创建中…" : "＋ 新建文件夹"),
        ),
        h("div", { className: "dsh-ssh-crumb" }, dirs !== null && !loading ? "共 " + dirs.length + " 个子文件夹" : " "),
        status ? h("p", { className: statusKind === "ok" ? "dsh-ssh-ok" : statusKind === "err" ? "dsh-ssh-err" : "dsh-ssh-hint" }, status) : null,
      );

      return h("div", { className: "dsh-ssh-modal" },
        h("div", { className: "dsh-ssh-modal-c" },
          h("div", { className: "dsh-ssh-modal-t" }, "选择工作区"),
          remoteBody,
          h("div", { className: "dsh-ssh-actions" },
            h("button", { className: "dsh-ssh-btn2", type: "button", onClick: onCancel }, "取消"),
            h("button", {
              className: "dsh-ssh-btn", type: "button", disabled: busy || loading,
              onClick: confirmRemote,
            }, isLocalMachine ? "选用此目录" : "在此目录工作"),
          ),
        ),
      );
    }

    /* ------------------------------------------------- settings card (React) */
    function ConnField({ field, value, onChange }) {
      let control;
      if (field.type === "select") {
        control = h("select", {
          className: "dsh-ssh-select",
          value: String(value ?? field.options[0][0]),
          onChange: (event) => onChange(event.target.value),
        },
          field.options.map(([v, label]) => h("option", { key: v, value: v }, label)),
        );
      } else {
        control = h("input", {
          className: "dsh-ssh-input",
          type: "text",
          inputMode: field.type === "number" ? "numeric" : undefined,
          value: value === undefined || value === null ? "" : String(value),
          placeholder: field.hint,
          onChange: (event) => {
            const raw = event.target.value;
            if (field.type === "number") {
              if (raw === "") return onChange("");
              const n = Number(raw);
              return onChange(Number.isFinite(n) ? n : raw);
            }
            onChange(raw);
          },
        });
      }
      return h("div", { className: "dsh-ssh-field" },
        h("span", { className: "dsh-ssh-label" }, field.label + (field.required ? " *" : "")),
        control,
        h("p", { className: "dsh-ssh-hint" }, field.hint),
      );
    }

    function ConnectionRow({ conn, index, onChange, onRemove, removable }) {
      const title = conn.name || "(未命名)";
      const summary = conn.host ? conn.user + "@" + conn.host + ":" + conn.port : "待填写";
      return h("div", { className: "dsh-ssh-conn" },
        h("div", { className: "dsh-ssh-conn-h" },
          h("span", { className: "dsh-ssh-conn-title" },
            (index === 0 ? "★ 默认 · " : "") + title + " — " + summary),
          removable ? h("button", { type: "button", className: "dsh-ssh-conn-del", onClick: onRemove }, "删除") : null,
        ),
        h("div", { className: "dsh-ssh-grid" },
          CONN_FIELDS.map((f) => h(ConnField, {
            key: f.key,
            field: f,
            value: conn[f.key],
            onChange: (v) => onChange(index, f.key, v),
          })),
        ),
      );
    }

    function ConfigCard() {
      useEffect(() => ensureCss(), []);
      const [open, setOpen] = useState(false);
      const [saved, setSaved] = useState(null);
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [err, setErr] = useState("");
      const [okMsg, setOkMsg] = useState("");

      useEffect(() => {
        let live = true;
        api("config", {})
          .then((d) => {
            if (!live) return;
            const list = pickConnections(d);
            if (list.length === 0) {
              list.push(newConnection({
                name: "default",
                host: d.host,
                port: d.port,
                user: d.user,
                identityFile: d.identityFile,
                defaultShell: d.defaultShell,
                defaultCwd: d.defaultCwd,
              }));
            }
            setSaved(list);
            setDraft(list.map((c) => ({ ...c })));
          })
          .catch((e) => { if (live) setErr(e.message || String(e)); });
        return () => { live = false; };
      }, []);

      const dirty = !!(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));

      const save = async () => {
        if (!draft) return;
        setSaving(true);
        setErr("");
        setOkMsg("");
        try {
          const d = await api("config", { save: true, connections: draft });
          const list = pickConnections(d);
          setSaved(list);
          setDraft(list.map((c) => ({ ...c })));
          setOkMsg("已保存，立即生效（起始目录需重启 DSH）");
        } catch (e) {
          setErr(e.message || String(e));
        } finally {
          setSaving(false);
        }
      };

      const discard = () => {
        setErr("");
        setOkMsg("");
        if (saved) setDraft(saved.map((c) => ({ ...c })));
      };

      const updateConn = (index, key, value) => {
        setDraft((list) => list.map((c, i) => (i === index ? { ...c, [key]: value } : c)));
      };
      const removeConn = (index) => setDraft((list) => list.filter((_, i) => i !== index));
      const addConn = () => setDraft((list) => [...list, newConnection({})]);

      const first = draft && draft[0];
      const summary = first && first.host
        ? "默认目标 " + first.name + " — " + first.user + "@" + first.host + ":" + first.port
        : "配置可通过 SSH 远程操作的个人电脑（反向隧道 / Tailscale / 直连）";

      return h("li", { className: "dsh-ssh-cfg-item" },
        h("div", { className: "dsh-ssh-cfg" },
          h("div", { className: "dsh-ssh-cfg-h" },
            h("button", {
              type: "button",
              className: "dsh-ssh-cfg-expand",
              "aria-expanded": open,
              onClick: () => setOpen((v) => !v),
            },
              h("span", { className: "dsh-ssh-cfg-t" },
                h("span", { className: "dsh-ssh-cfg-n" }, "SSH 远程连接"),
                h("span", { className: "dsh-ssh-cfg-d" }, summary),
              ),
              err ? h("span", { className: "dsh-ssh-badge" }, "错误") :
                dirty ? h("span", { className: "dsh-ssh-badge" }, "未保存") :
                  okMsg ? h("span", { className: "dsh-ssh-badge ok" }, "已保存") :
                    draft && draft.length > 1 ? h("span", { className: "dsh-ssh-badge ok" }, draft.length + " 台机器") : null,
            ),
          ),
          open ? h("div", { className: "dsh-ssh-cfg-b" },
            draft
              ? draft.map((conn, i) => h(ConnectionRow, {
                  key: i, conn, index: i,
                  onChange: updateConn,
                  onRemove: () => removeConn(i),
                  removable: draft.length > 1,
                }))
              : h("p", { className: "dsh-ssh-hint" }, "加载配置…"),
            h("button", { type: "button", className: "dsh-ssh-add", onClick: addConn }, "+ 添加一台电脑"),
            h("p", { className: "dsh-ssh-hint" },
              "排第 1（★）的是默认目标；新建会话时可在「选择工作区」弹窗里浏览并选定个人电脑文件夹。"),
            err ? h("p", { className: "dsh-ssh-err" }, err) : null,
            okMsg ? h("p", { className: "dsh-ssh-ok" }, okMsg) : null,
            h("div", { className: "dsh-ssh-actions" },
              h("button", { type: "button", className: "dsh-ssh-btn2", disabled: saving || !dirty, onClick: discard }, "丢弃修改"),
              h("button", { type: "button", className: "dsh-ssh-btn", disabled: saving || !dirty, onClick: save }, saving ? "保存中…" : "保存"),
            ),
          ) : null,
        ),
      );
    }

    /* ------------------------------------------------------- registration */
    // rc.6 list slots require `id`; rc.7+ keyed slots require `key`. Pass both.
    function registerSlot(slots, options, component) {
      const next = { ...options };
      if (next.id == null && next.key != null) next.id = String(next.key);
      if (next.key == null && next.id != null) next.key = next.id;
      return slots.register(next, component);
    }

    const inject = ["slots"];

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots) return;
      ctx.effect(() => ensureCss(), "deepseek-harness-ssh:settings-style");

      // 原生「选择工作区」流程：以 priority -100 填充 directory-flow 洞
      //（借鉴 dsh-remote 的挂载方式，生成器工厂一次注册两个 slot）
      slots.inject("conversation.hero.workspace.directoryFlow", () => slots.inject("sidebar.workspaces.directoryFlow", function* () {
        yield slots.register({ name: "conversation.hero.workspace.directoryFlow", id: NS, priority: -100 }, DirPicker);
        yield slots.register({ name: "sidebar.workspaces.directoryFlow", id: NS, priority: -100 }, DirPicker);
      }));

      slots.inject("settings.plugin.item", () => registerSlot(
        slots,
        { name: "settings.plugin.item", key: NS, id: NS },
        ConfigCard,
      ));
    }

    return { inject, apply };
  },
});
