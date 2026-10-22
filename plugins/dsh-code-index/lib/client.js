window.__ModuleLoader__.load({
	// 官方约定：factory id 必须等于 package.json 的包名（不是 Loader 条目 id）。
	id: "@local/dsh-code-index",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const NS = "settings.codeIndex";
		const inject = ["slots", "locale", "configForms"];
		const CSS = `
.dci-page { display: flex; flex-direction: column; gap: 16px; max-width: 760px; color: var(--dsw-alias-label-primary, inherit); }
.dci-section { display: flex; flex-direction: column; gap: 14px; }
.dci-field { display: flex; flex-direction: column; gap: 6px; }
.dci-label { font-size: 13px; font-weight: 600; }
.dci-hint { margin: 0; font-size: 11.5px; line-height: 1.5; opacity: .72; }
.dci-invalid { color: var(--dsw-alias-label-danger, #c53); }
.dci-input, .dci-select { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-default, #ccc); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
.dci-input:focus, .dci-select:focus { outline: 2px solid var(--dsw-alias-border-accent, #4a8cff); outline-offset: -1px; }
.dci-input:disabled, .dci-select:disabled { opacity: .6; }
.dci-details { border: 1px solid var(--dsw-alias-border-default, #ddd); border-radius: 10px; padding: 10px 12px; }
.dci-summary { cursor: pointer; font-size: 12px; opacity: .72; }
.dci-detailBody { display: flex; flex-direction: column; gap: 14px; padding-top: 12px; }
.dci-footer { display: flex; align-items: center; gap: 12px; }
.dci-save { padding: 7px 18px; border: 0; border-radius: 8px; background: var(--dsw-alias-bg-accent, #1f6feb); color: var(--dsw-alias-label-on-accent, #fff); font: inherit; cursor: pointer; }
.dci-save:disabled { opacity: .45; cursor: default; }
.dci-status { margin: 0; font-size: 12px; }
.dci-status.ok { color: var(--dsw-alias-label-success, #1a7f37); }
.dci-status.bad { color: var(--dsw-alias-label-danger, #c53); }
.dci-loading { font-size: 12px; opacity: .72; }
`;

		const zh = {
			title: "代码索引",
			description: "配置远端索引服务与本地索引行为。",
			urlLabel: "远端地址",
			urlHint: "例如 https://dsh-embed.taek.site；留空则不使用远端向量检索。",
			urlInvalid: "远端地址必须以 http:// 或 https:// 开头。",
			apiKeyLabel: "API Key",
			apiKeyHint: "留空保持当前密钥；已配置的密钥不会回显。",
			advanced: "高级设置",
			vectorsLabel: "向量模式",
			vectorsHint: "auto：有远端地址就用远端；remote：强制远端；off：只用本地关键词。",
			rerankLabel: "重排模式",
			rerankHint: "off 关闭；fast / quality 使用远端重排。",
			indexDirLabel: "本地索引目录",
			indexDirHint: "留空使用仓库内 .dsh-index/；仅影响本地 SQLite，不影响远端检索。",
			save: "保存",
			saving: "保存中…",
			loading: "读取配置中…",
			unavailable: "配置暂不可用。",
			readOnly: "当前 profile 只读，无法保存。",
			saved: "已保存。索引目录或根目录变化后，重新运行 code_index 以重建本地索引。",
			failed: "保存失败，请检查输入或稍后重试。",
			advancedNote: "修改向量模式或本地索引目录后，需要重新运行 code_index 重建索引。",
			vectorsAuto: "auto（自动）",
			vectorsRemote: "remote（强制远端）",
			vectorsOff: "off（纯关键词）",
			rerankOff: "off（关闭）",
			rerankFast: "fast（快速）",
			rerankQuality: "quality（高质量）",
		};

		const en = {
			title: "Code index",
			description: "Configure the remote index service and local index behavior.",
			urlLabel: "Remote URL",
			urlHint: "For example https://dsh-embed.taek.site. Leave blank to disable remote vectors.",
			urlInvalid: "Remote URL must start with http:// or https://.",
			apiKeyLabel: "API key",
			apiKeyHint: "Leave blank to keep the current key; configured keys are never returned.",
			advanced: "Advanced",
			vectorsLabel: "Vector mode",
			vectorsHint: "auto uses the remote when a URL is set; remote forces it; off uses local keywords only.",
			rerankLabel: "Rerank mode",
			rerankHint: "off disables rerank; fast / quality use the remote reranker.",
			indexDirLabel: "Local index directory",
			indexDirHint: "Blank uses .dsh-index/ inside each repository. Affects local SQLite only.",
			save: "Save",
			saving: "Saving…",
			loading: "Reading configuration…",
			unavailable: "Configuration is unavailable.",
			readOnly: "This profile is read-only.",
			saved: "Saved. Re-run code_index if the index directory or roots changed.",
			failed: "Save failed. Check the values or try again.",
			advancedNote: "Re-run code_index after changing the vector mode or local index directory.",
			vectorsAuto: "auto",
			vectorsRemote: "remote (force)",
			vectorsOff: "off (keyword only)",
			rerankOff: "off",
			rerankFast: "fast",
			rerankQuality: "quality",
		};

		function str(value) {
			return value === null || value === undefined ? "" : String(value);
		}

		function valueAt(value, pathParts) {
			let current = value;
			for (const key of pathParts) {
				if (current === null || current === undefined || typeof current !== "object") return undefined;
				current = current[key];
			}
			return current;
		}

		function draftFromSnapshot(state) {
			const value = state && state.value && typeof state.value === "object" ? state.value : {};
			return {
				url: str(valueAt(value, ["remote", "url"])),
				apiKey: "",
				vectors: str(valueAt(value, ["vectors"])) || "auto",
				rerank: str(valueAt(value, ["rerank"])) || "off",
				indexDirBase: str(valueAt(value, ["advanced", "indexDirBase"])),
			};
		}

		function Field(props) {
			const { id, label, hint, value, onEdit, type, disabled, invalid } = props;
			return h(
				"div",
				{ className: "dci-field" },
				h("label", { className: "dci-label", htmlFor: id }, label),
				h("input", {
					id,
					className: "dci-input",
					type: type || "text",
					value,
					disabled,
					onChange: (event) => onEdit(event.target.value),
					"aria-invalid": invalid ? true : undefined,
				}),
				h("p", { className: invalid ? "dci-hint dci-invalid" : "dci-hint" }, hint),
			);
		}

		function SelectField(props) {
			const { id, label, hint, value, options, labels, onEdit, disabled } = props;
			return h(
				"div",
				{ className: "dci-field" },
				h("label", { className: "dci-label", htmlFor: id }, label),
				h(
					"select",
					{
						id,
						className: "dci-select",
						value,
						disabled,
						onChange: (event) => onEdit(event.target.value),
					},
					options.map((option) => h("option", { value: option, key: option }, (labels && labels[option]) || option)),
				),
				h("p", { className: "dci-hint" }, hint),
			);
		}

		function CodeIndexForm(props) {
			const { form, t } = props;
			const [state, setState] = React.useState(() => (form ? form.getSnapshot() : null));
			const [draft, setDraft] = React.useState(() => draftFromSnapshot(state));
			const [saving, setSaving] = React.useState(false);
			const [failed, setFailed] = React.useState(false);
			const [notice, setNotice] = React.useState("");

			React.useEffect(() => {
				if (!form) return undefined;
				setState(form.getSnapshot());
				return form.subscribe(() => setState(form.getSnapshot()));
			}, [form]);

			if (!form) return h("p", { className: "dci-hint" }, t("unavailable"));
			const shell = state || {};
			if (shell.status === "loading" || shell.status === undefined) return h("p", { className: "dci-loading" }, t("loading"));
			if (shell.status === "unavailable") return h("p", { className: "dci-hint" }, t("unavailable"));

			const current = shell.value || {};
			const currentUrl = str(valueAt(current, ["remote", "url"]));
			const currentVectors = str(valueAt(current, ["vectors"])) || "auto";
			const currentRerank = str(valueAt(current, ["rerank"])) || "off";
			const currentIndexDir = str(valueAt(current, ["advanced", "indexDirBase"]));
			const writable = shell.writable !== false;
			const invalidUrl = draft.url.trim() !== "" && !/^https?:\/\//i.test(draft.url.trim());
			const dirty =
				draft.url.trim() !== currentUrl ||
				draft.apiKey.trim() !== "" ||
				draft.vectors !== currentVectors ||
				draft.rerank !== currentRerank ||
				draft.indexDirBase.trim() !== currentIndexDir;
			const disabled = !writable || saving;

			const edit = (key) => (value) => {
				setDraft((previous) => ({ ...previous, [key]: value }));
				setFailed(false);
				setNotice("");
			};

			async function save() {
				if (!writable || invalidUrl || !dirty) return;
				const operations = [];
				const url = draft.url.trim();
				if (url !== currentUrl) {
					operations.push(url ? { op: "set", path: ["remote", "url"], value: url } : { op: "unset", path: ["remote", "url"] });
				}
				if (draft.apiKey.trim() !== "") {
					operations.push({ op: "set", path: ["remote", "apiKey"], value: draft.apiKey.trim() });
				}
				if (draft.vectors !== currentVectors) operations.push({ op: "set", path: ["vectors"], value: draft.vectors });
				if (draft.rerank !== currentRerank) operations.push({ op: "set", path: ["rerank"], value: draft.rerank });
				const indexDirBase = draft.indexDirBase.trim();
				if (indexDirBase !== currentIndexDir) {
					operations.push(indexDirBase ? { op: "set", path: ["advanced", "indexDirBase"], value: indexDirBase } : { op: "unset", path: ["advanced", "indexDirBase"] });
				}
				if (!operations.length) return;
				setSaving(true);
				setFailed(false);
				setNotice("");
				try {
					const accepted = await form.mutate(operations, shell.revision);
					if (accepted) {
						const next = form.getSnapshot();
						setState(next);
						setDraft(draftFromSnapshot(next));
						setNotice(t("saved"));
					} else {
						setFailed(true);
						setState(form.getSnapshot());
					}
				} catch (error) {
					setFailed(true);
				} finally {
					setSaving(false);
				}
			}

			return h(
				"div",
				{ className: "dci-page" },
				writable ? null : h("p", { className: "dci-hint" }, t("readOnly")),
				h(
					"div",
					{ className: "dci-section" },
					h(Field, {
						id: "plugin-config-code-index-url",
						label: t("urlLabel"),
						hint: invalidUrl ? t("urlInvalid") : t("urlHint"),
						invalid: invalidUrl,
						value: draft.url,
						onEdit: edit("url"),
						disabled,
					}),
					h(Field, {
						id: "plugin-config-code-index-key",
						label: t("apiKeyLabel"),
						hint: t("apiKeyHint"),
						value: draft.apiKey,
						onEdit: edit("apiKey"),
						type: "password",
						disabled,
					}),
					h(
						"details",
						{ className: "dci-details" },
						h("summary", { className: "dci-summary" }, t("advanced")),
						h(
							"div",
							{ className: "dci-detailBody" },
							h(SelectField, {
								id: "plugin-config-code-index-vectors",
								label: t("vectorsLabel"),
								hint: t("vectorsHint"),
								value: draft.vectors,
								options: ["auto", "remote", "off"],
								labels: { auto: t("vectorsAuto"), remote: t("vectorsRemote"), off: t("vectorsOff") },
								onEdit: edit("vectors"),
								disabled,
							}),
							h(SelectField, {
								id: "plugin-config-code-index-rerank",
								label: t("rerankLabel"),
								hint: t("rerankHint"),
								value: draft.rerank,
								options: ["off", "fast", "quality"],
								labels: { off: t("rerankOff"), fast: t("rerankFast"), quality: t("rerankQuality") },
								onEdit: edit("rerank"),
								disabled,
							}),
							h(Field, {
								id: "plugin-config-code-index-indexdir",
								label: t("indexDirLabel"),
								hint: t("indexDirHint"),
								value: draft.indexDirBase,
								onEdit: edit("indexDirBase"),
								disabled,
							}),
							h("p", { className: "dci-hint" }, t("advancedNote")),
						),
					),
					failed ? h("p", { className: "dci-status bad", role: "status" }, t("failed")) : null,
					notice ? h("p", { className: "dci-status ok", role: "status" }, notice) : null,
					h(
						"div",
						{ className: "dci-footer" },
						h(
							"button",
							{
								type: "button",
								className: "dci-save",
								disabled: disabled || invalidUrl || !dirty,
								onClick: save,
							},
							saving ? t("saving") : t("save"),
						),
					),
				),
			);
		}

		function CodeIndexCard(props) {
			const t = props.t || ((key) => key);
			if (props.view === "summary") return t("description");
			// 插件页宿主传的 form 是 {state, mutate} 快照，不提供 subscribe；
			// 这里通过 slot inject 使用真正的 ConfigForm（getSnapshot/subscribe/mutate）。
			return h(CodeIndexForm, { form: props.configForm, t });
		}

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(
				() => {
					const style = document.createElement("style");
					style.dataset.plugin = "@local/dsh-code-index";
					style.textContent = CSS;
					document.head.append(style);
					return () => style.remove();
				},
				"dsh-code-index: settings styles",
			);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-code-index: settings dictionaries");
			ctx.effect(
				() =>
					ctx.configForms.whileServed(["code-index"], () =>
						ctx.slots.inject("plugins.item", () =>
							ctx.slots.register(
								{
									name: "plugins.item",
									id: "code-index",
									order: 40,
									label: () => t("title"),
									locale: NS,
									inject: () => ({ configForm: ctx.configForms.get("code-index") }),
								},
								CodeIndexCard,
							),
						),
					),
				"dsh-code-index: settings page",
			);
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
