/**
 * @name ServerActivity
 * @author Rapha
 * @description Mostra metricas de atividade de todos os servidores para ajudar a decidir quais manter ou sair. Zero chamadas de API - usa dados locais do cliente.
 * @version 1.0.0
 * @source https://github.com/rapha30/bd-plugins
 * @updateUrl https://raw.githubusercontent.com/rapha30/bd-plugins/master/ServerActivity.plugin.js
 */

module.exports = class ServerActivity {
    constructor(meta) {
        this.meta = meta;
        this.settings = {
            greenThresholdDays: 7,
            yellowThresholdDays: 30,
            columns: {
                lastActivity: true,
                onlineRatio: true,
                unreadChannels: true,
                mentionCount: true,
                channelCount: true,
                memberCount: true,
                serverAge: true,
                myRole: true
            },
            sortBy: "lastActivity",
            sortAsc: true,
            autoCollect: true
        };
        this.styleId = "server-activity-styles";
        this.buttonId = "server-activity-btn";
        this.modules = {};
        this.observer = null;

        // Collected data
        this._serverData = [];
        this._isCollecting = false;
        this._lastCollectedAt = null;
        this._currentFilter = "all";
        this._currentFolderFilter = "all";
    }

    // ========== LOGGING ==========

    _initLog() {
        try {
            this._fs = require("fs");
            this._logPath = require("path").join(__dirname, "ServerActivity.log");
            this._fs.writeFileSync(this._logPath, `[ServerActivity] Log iniciado: ${new Date().toISOString()}\n`);
        } catch (e) {
            console.error("[ServerActivity] Nao conseguiu iniciar log:", e);
            this._fs = null;
        }
    }

    log(msg) {
        const line = `[${new Date().toLocaleTimeString("pt-BR")}] ${msg}`;
        console.log(`[ServerActivity] ${msg}`);
        if (this._fs) {
            try { this._fs.appendFileSync(this._logPath, line + "\n"); } catch {}
        }
    }

    // ========== LIFECYCLE ==========

    start() {
        this._initLog();
        try {
            this.loadSettings();
            this.log("Settings carregadas");
            this.cacheModules();
            this.log("Modules cacheados");
            this.injectStyles();
            this.log("Styles injetados");
            this.injectButton();
            this.log("Button injetado");
            this.setupObserver();
            this.log("Plugin ativado com sucesso!");
            BdApi.UI.showToast("ServerActivity ativado!", { type: "success" });
        } catch (e) {
            this.log(`ERRO no start(): ${e.message}\n${e.stack}`);
        }
    }

    stop() {
        this.removeButton();
        this.removeStyles();
        const overlay = document.querySelector(".sa-modal-overlay");
        if (overlay) overlay.remove();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        BdApi.UI.showToast("ServerActivity desativado!", { type: "info" });
    }

    // ========== SETTINGS ==========

    loadSettings() {
        const saved = BdApi.Data.load(this.meta.name, "settings");
        if (saved) this.settings = Object.assign({}, this.settings, saved);
        // Merge columns defaults in case new columns were added
        const defaultCols = { lastActivity: true, onlineRatio: true, unreadChannels: true, mentionCount: true, channelCount: true, memberCount: true, serverAge: true, myRole: true };
        this.settings.columns = Object.assign({}, defaultCols, this.settings.columns || {});
    }

    saveSettings() {
        BdApi.Data.save(this.meta.name, "settings", this.settings);
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.padding = "16px";
        panel.style.color = "var(--text-normal)";

        const inputStyle = "width:60px;padding:6px 8px;border-radius:4px;border:1px solid var(--background-tertiary);background:var(--background-secondary);color:var(--text-normal);";

        // Green threshold
        const greenLabel = document.createElement("label");
        greenLabel.textContent = "Dias para verde (ativo):";
        greenLabel.style.cssText = "display:block;margin-bottom:4px;font-weight:600;";
        const greenInput = document.createElement("input");
        greenInput.type = "number";
        greenInput.min = "1";
        greenInput.max = "365";
        greenInput.value = this.settings.greenThresholdDays;
        greenInput.style.cssText = inputStyle;
        greenInput.addEventListener("change", () => {
            this.settings.greenThresholdDays = parseInt(greenInput.value) || 7;
            this.saveSettings();
        });

        // Yellow threshold
        const yellowLabel = document.createElement("label");
        yellowLabel.textContent = "Dias para amarelo (aviso):";
        yellowLabel.style.cssText = "display:block;margin-top:12px;margin-bottom:4px;font-weight:600;";
        const yellowInput = document.createElement("input");
        yellowInput.type = "number";
        yellowInput.min = "1";
        yellowInput.max = "365";
        yellowInput.value = this.settings.yellowThresholdDays;
        yellowInput.style.cssText = inputStyle;
        yellowInput.addEventListener("change", () => {
            this.settings.yellowThresholdDays = parseInt(yellowInput.value) || 30;
            this.saveSettings();
        });

        // Columns section
        const colTitle = document.createElement("div");
        colTitle.textContent = "Colunas visiveis:";
        colTitle.style.cssText = "display:block;margin-top:16px;margin-bottom:8px;font-weight:600;";

        const colLabels = {
            lastActivity: "Ultima Atividade",
            onlineRatio: "Online %",
            unreadChannels: "Nao Lidos",
            mentionCount: "Mencoes",
            channelCount: "Canais",
            memberCount: "Membros",
            serverAge: "Criado em",
            myRole: "Meu Cargo"
        };

        const colContainer = document.createElement("div");
        colContainer.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";

        for (const [key, label] of Object.entries(colLabels)) {
            const wrap = document.createElement("label");
            wrap.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = this.settings.columns[key] !== false;
            cb.addEventListener("change", () => {
                this.settings.columns[key] = cb.checked;
                this.saveSettings();
            });
            const span = document.createElement("span");
            span.textContent = label;
            span.style.fontSize = "13px";
            wrap.append(cb, span);
            colContainer.appendChild(wrap);
        }

        panel.append(greenLabel, greenInput, yellowLabel, yellowInput, colTitle, colContainer);
        return panel;
    }

    // ========== DISCORD MODULES ==========

    cacheModules() {
        this.modules.GuildStore = BdApi.Webpack.getStore("GuildStore");
        this.modules.ChannelStore = BdApi.Webpack.getStore("ChannelStore");
        this.modules.GuildChannelStore = BdApi.Webpack.getStore("GuildChannelStore");
        this.modules.GuildMemberCountStore = BdApi.Webpack.getStore("GuildMemberCountStore");
        this.modules.ReadStateStore = BdApi.Webpack.getStore("ReadStateStore");
        this.modules.GuildMemberStore = BdApi.Webpack.getStore("GuildMemberStore");
        this.modules.UserStore = BdApi.Webpack.getStore("UserStore");
        this.modules.SelectedGuildStore = BdApi.Webpack.getStore("SelectedGuildStore");
        this.modules.SortedGuildStore = BdApi.Webpack.getStore("SortedGuildStore");

        // Token module (only for leave server)
        this.modules.TokenModule = BdApi.Webpack.getModule(m => m?.getToken && m?.getEmail, { searchExports: false })
            || BdApi.Webpack.getByKeys("getToken", "getEmail");

        // Navigation
        this.modules.NavigationUtils = BdApi.Webpack.getByKeys("transitionTo", "transitionToGuild");

        this.log(`Modules: Guild=${!!this.modules.GuildStore} Channel=${!!this.modules.ChannelStore} GuildChannel=${!!this.modules.GuildChannelStore} MemberCount=${!!this.modules.GuildMemberCountStore} ReadState=${!!this.modules.ReadStateStore} GuildMember=${!!this.modules.GuildMemberStore} User=${!!this.modules.UserStore} Token=${!!this.modules.TokenModule} Nav=${!!this.modules.NavigationUtils}`);
    }

    getGuildFolders() {
        const folders = [];
        try {
            const store = this.modules.SortedGuildStore;
            if (store?.getGuildFolders) {
                const rawFolders = store.getGuildFolders();
                for (const folder of rawFolders) {
                    if (folder.folderId && folder.guildIds && folder.guildIds.length > 1) {
                        folders.push({
                            id: folder.folderId,
                            name: folder.folderName || `Pasta (${folder.guildIds.length} servidores)`,
                            color: folder.folderColor,
                            guildIds: [...folder.guildIds]
                        });
                    }
                }
            }
        } catch (e) {
            this.log(`Erro ao pegar pastas: ${e.message}`);
        }
        return folders;
    }

    _getGuildIdsInAnyFolder() {
        const folders = this.getGuildFolders();
        const ids = new Set();
        for (const f of folders) {
            for (const gId of f.guildIds) ids.add(gId);
        }
        return ids;
    }

    // ========== SNOWFLAKE UTILS ==========

    snowflakeToTimestamp(snowflake) {
        if (!snowflake) return null;
        try {
            return Number(BigInt(snowflake) >> 22n) + 1420070400000;
        } catch {
            return null;
        }
    }

    timestampToAge(ms) {
        if (!ms) return "Sem dados";
        const diff = Date.now() - ms;
        if (diff < 0) return "Agora";
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        const months = Math.floor(days / 30);
        const years = Math.floor(days / 365);

        if (minutes < 1) return "Agora";
        if (minutes < 60) return `${minutes}m`;
        if (hours < 24) return `${hours}h`;
        if (days < 30) return `${days}d`;
        if (months < 12) return `${months} mes${months > 1 ? "es" : ""}`;
        return `${years} ano${years > 1 ? "s" : ""}`;
    }

    getActivityColor(lastActivityMs) {
        if (!lastActivityMs) return "sa-health-red";
        const days = (Date.now() - lastActivityMs) / 86400000;
        if (days <= this.settings.greenThresholdDays) return "sa-health-green";
        if (days <= this.settings.yellowThresholdDays) return "sa-health-yellow";
        return "sa-health-red";
    }

    // ========== DATA COLLECTION ==========

    collectServerData() {
        this._isCollecting = true;
        const guilds = this.modules.GuildStore?.getGuilds();
        if (!guilds) {
            this.log("GuildStore indisponivel");
            this._isCollecting = false;
            return [];
        }
        const guildList = Object.values(guilds);
        const currentUser = this.modules.UserStore?.getCurrentUser();
        const results = [];

        for (const guild of guildList) {
            const guildId = guild.id;

            // --- Channel analysis ---
            let channels = [];
            try {
                const channelData = this.modules.GuildChannelStore?.getChannels(guildId);
                if (channelData?.SELECTABLE) {
                    channels = channelData.SELECTABLE
                        .map(entry => entry.channel)
                        .filter(ch => ch && (ch.type === 0 || ch.type === 5)); // text + announcement
                }
            } catch (e) {
                this.log(`Erro canais ${guild.name}: ${e.message}`);
            }

            // --- Last activity (from lastMessageId snowflakes) ---
            let lastActivityMs = 0;
            let lastActiveChannel = null;
            for (const ch of channels) {
                const fullChannel = this.modules.ChannelStore?.getChannel(ch.id);
                if (fullChannel?.lastMessageId) {
                    const ts = this.snowflakeToTimestamp(fullChannel.lastMessageId);
                    if (ts && ts > lastActivityMs) {
                        lastActivityMs = ts;
                        lastActiveChannel = fullChannel.name;
                    }
                }
            }

            // --- Member counts ---
            const memberCount = this.modules.GuildMemberCountStore?.getMemberCount(guildId) || 0;
            const onlineCount = this.modules.GuildMemberCountStore?.getOnlineCount(guildId) || 0;
            const onlineRatio = memberCount > 0 ? (onlineCount / memberCount) : 0;

            // --- Unread / mentions ---
            let unreadChannels = 0;
            let totalMentions = 0;
            for (const ch of channels) {
                try {
                    if (this.modules.ReadStateStore?.hasUnread(ch.id)) {
                        unreadChannels++;
                    }
                    const mentions = this.modules.ReadStateStore?.getMentionCount(ch.id) || 0;
                    totalMentions += mentions;
                } catch {}
            }

            // --- Server age ---
            const serverCreatedMs = this.snowflakeToTimestamp(guildId);

            // --- My role ---
            let myRole = "Membro";
            if (guild.ownerId === currentUser?.id) {
                myRole = "Dono";
            } else if (currentUser) {
                try {
                    const member = this.modules.GuildMemberStore?.getMember(guildId, currentUser.id);
                    if (member?.roles?.length > 0 && guild.roles) {
                        const roles = member.roles
                            .map(rId => guild.roles[rId])
                            .filter(Boolean)
                            .sort((a, b) => b.position - a.position);
                        if (roles.length > 0) myRole = roles[0].name;
                    }
                } catch {}
            }

            results.push({
                id: guildId,
                name: guild.name,
                icon: guild.icon
                    ? `https://cdn.discordapp.com/icons/${guildId}/${guild.icon}.png?size=32`
                    : null,
                ownerId: guild.ownerId,
                isOwner: guild.ownerId === currentUser?.id,
                lastActivityMs: lastActivityMs || null,
                lastActiveChannel,
                memberCount,
                onlineCount,
                onlineRatio,
                unreadChannels,
                totalMentions,
                channelCount: channels.length,
                serverCreatedMs,
                myRole
            });
        }

        this._serverData = results;
        this._isCollecting = false;
        this._lastCollectedAt = Date.now();
        this.log(`Coleta finalizada: ${results.length} servidores analisados`);
        return results;
    }

    // ========== SERVER ACTIONS ==========

    getToken() {
        if (this.modules.TokenModule?.getToken) {
            return this.modules.TokenModule.getToken();
        }
        const authStore = BdApi.Webpack.getStore("AuthenticationStore");
        if (authStore?.getToken) return authStore.getToken();
        // Webpack chunk fallback
        let token = null;
        try {
            webpackChunkdiscord_app.push([[""], {}, e => {
                for (let c in e.c) {
                    try {
                        const m = e.c[c]?.exports;
                        if (m?.default?.getToken) { token = m.default.getToken(); return; }
                        if (m?.getToken && typeof m.getToken === "function") { token = m.getToken(); return; }
                    } catch {}
                }
            }]);
        } catch {}
        return token;
    }

    async leaveServer(guildId, guildName) {
        const token = this.getToken();
        if (!token) {
            BdApi.UI.showToast("Token nao encontrado!", { type: "error" });
            return false;
        }
        try {
            const resp = await fetch(`https://discord.com/api/v9/users/@me/guilds/${guildId}`, {
                method: "DELETE",
                headers: {
                    "Authorization": token,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ lurking: false })
            });
            if (resp.ok || resp.status === 204) {
                this.log(`Saiu do servidor: ${guildName} (${guildId})`);
                this._serverData = this._serverData.filter(s => s.id !== guildId);
                BdApi.UI.showToast(`Voce saiu de "${guildName}"!`, { type: "success" });
                return true;
            }
            if (resp.status === 429) {
                const data = await resp.json().catch(() => ({}));
                const retryAfter = data.retry_after || 5;
                BdApi.UI.showToast(`Rate limited! Tente em ${Math.ceil(retryAfter)}s.`, { type: "warning" });
                return false;
            }
            this.log(`Erro ao sair: ${resp.status}`);
            BdApi.UI.showToast("Erro ao sair do servidor.", { type: "error" });
            return false;
        } catch (err) {
            this.log(`Erro leaveServer: ${err.message}`);
            BdApi.UI.showToast("Erro ao sair do servidor.", { type: "error" });
            return false;
        }
    }

    goToServer(guildId) {
        if (this.modules.NavigationUtils?.transitionToGuild) {
            try { this.modules.NavigationUtils.transitionToGuild(guildId); return; } catch {}
        }
        if (this.modules.NavigationUtils?.transitionTo) {
            try { this.modules.NavigationUtils.transitionTo(`/channels/${guildId}`); return; } catch {}
        }
        try {
            window.history.pushState(null, "", `/channels/${guildId}`);
            window.dispatchEvent(new PopStateEvent("popstate"));
        } catch {}
    }

    // ========== UI: TOOLBAR BUTTON ==========

    injectButton() {
        if (document.getElementById(this.buttonId)) return;
        const toolbar = document.querySelector('[class*="toolbar_"]')
            || document.querySelector('[class*="toolbar-"]')
            || document.querySelector('[class*="Toolbar"]');
        if (!toolbar) return;

        const btn = document.createElement("div");
        btn.id = this.buttonId;
        btn.className = "server-activity-toolbar-btn";
        btn.title = "Atividade dos Servidores";
        btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h2v8H3zm4-4h2v12H7zm4-4h2v16h-2zm4 8h2v8h-2zm4-4h2v12h-2z"/></svg>`;
        btn.addEventListener("click", () => this.openModal());
        toolbar.insertBefore(btn, toolbar.firstChild);
    }

    removeButton() {
        const btn = document.getElementById(this.buttonId);
        if (btn) btn.remove();
    }

    setupObserver() {
        this.observer = new MutationObserver(() => {
            if (!document.getElementById(this.buttonId)) {
                this.injectButton();
            }
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    // ========== UI: MODAL ==========

    openModal() {
        // Remove existing
        const existing = document.querySelector(".sa-modal-overlay");
        if (existing) existing.remove();

        // Collect data
        if (!this._serverData.length || this.settings.autoCollect) {
            this.collectServerData();
        }

        // Overlay
        const overlay = document.createElement("div");
        overlay.className = "sa-modal-overlay";
        overlay.addEventListener("click", e => {
            if (e.target === overlay) overlay.remove();
        });

        // Modal
        const modal = document.createElement("div");
        modal.className = "sa-modal";

        // Header
        const header = document.createElement("div");
        header.className = "sa-modal-header";
        const title = document.createElement("h2");
        title.textContent = "Atividade dos Servidores";
        const closeBtn = document.createElement("div");
        closeBtn.className = "sa-close";
        closeBtn.textContent = "\u00D7";
        closeBtn.addEventListener("click", () => overlay.remove());
        header.append(title, closeBtn);

        // Controls
        const controls = document.createElement("div");
        controls.className = "sa-controls";

        const refreshBtn = document.createElement("button");
        refreshBtn.className = "sa-btn sa-refresh-btn";
        refreshBtn.textContent = "Atualizar";
        refreshBtn.addEventListener("click", () => {
            this.collectServerData();
            this.renderTable(tableBody);
            updateFooter();
            updateCount();
            BdApi.UI.showToast("Dados atualizados!", { type: "success" });
        });

        const filterSelect = document.createElement("select");
        filterSelect.className = "sa-filter-select";
        const filterOptions = [
            { value: "all", label: "Todos os servidores" },
            { value: "hide7", label: "Esconder ativos (< 7d)" },
            { value: "hide30", label: "Esconder ativos (< 30d)" },
            { value: "dead30", label: "So mortos (> 30d)" },
            { value: "dead90", label: "So mortos (> 90d)" },
            { value: "unread", label: "Com nao lidos" },
            { value: "mentions", label: "Com mencoes" }
        ];
        for (const opt of filterOptions) {
            const o = document.createElement("option");
            o.value = opt.value;
            o.textContent = opt.label;
            if (opt.value === this._currentFilter) o.selected = true;
            filterSelect.appendChild(o);
        }
        filterSelect.addEventListener("change", () => {
            this._currentFilter = filterSelect.value;
            this.renderTable(tableBody);
            updateCount();
        });

        // Folder filter
        const folderSelect = document.createElement("select");
        folderSelect.className = "sa-filter-select";
        const folders = this.getGuildFolders();

        const allFolderOpt = document.createElement("option");
        allFolderOpt.value = "all";
        allFolderOpt.textContent = "Todas as pastas";
        if (this._currentFolderFilter === "all") allFolderOpt.selected = true;
        folderSelect.appendChild(allFolderOpt);

        const noneFolderOpt = document.createElement("option");
        noneFolderOpt.value = "none";
        noneFolderOpt.textContent = "Sem pasta";
        if (this._currentFolderFilter === "none") noneFolderOpt.selected = true;
        folderSelect.appendChild(noneFolderOpt);

        for (const folder of folders) {
            const o = document.createElement("option");
            o.value = String(folder.id);
            o.textContent = `${folder.name} (${folder.guildIds.length})`;
            if (String(this._currentFolderFilter) === String(folder.id)) o.selected = true;
            folderSelect.appendChild(o);
        }
        folderSelect.addEventListener("change", () => {
            this._currentFolderFilter = folderSelect.value;
            this.renderTable(tableBody);
            updateCount();
        });

        const countSpan = document.createElement("span");
        countSpan.className = "sa-server-count";

        controls.append(refreshBtn, filterSelect, folderSelect, countSpan);

        // Table wrapper
        const tableWrapper = document.createElement("div");
        tableWrapper.className = "sa-table-wrapper";

        const tableHeader = document.createElement("div");
        tableHeader.className = "sa-table-header";

        const tableBody = document.createElement("div");
        tableBody.className = "sa-table-body";

        tableWrapper.append(tableHeader, tableBody);

        // Footer
        const footer = document.createElement("div");
        footer.className = "sa-modal-footer";

        const updateFooter = () => {
            if (this._lastCollectedAt) {
                const d = new Date(this._lastCollectedAt);
                footer.textContent = `Coletado em ${d.toLocaleDateString("pt-BR")} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
            }
        };

        const updateCount = () => {
            const filtered = this._getFilteredData();
            countSpan.textContent = filtered.length === this._serverData.length
                ? `${this._serverData.length} servidores`
                : `${filtered.length} de ${this._serverData.length} servidores`;
        };

        // Store refs for table rebuild on sort
        this._tableHeaderEl = tableHeader;
        this._tableBodyEl = tableBody;
        this._updateCountFn = updateCount;

        // Assemble
        modal.append(header, controls, tableWrapper, footer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Escape key
        const escHandler = (e) => {
            if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", escHandler); }
        };
        document.addEventListener("keydown", escHandler);

        // Initial render
        this._buildTableHeader(tableHeader);
        this.renderTable(tableBody);
        updateFooter();
        updateCount();
    }

    // ========== UI: TABLE ==========

    _getColumns() {
        const allColumns = [
            { key: "name",           label: "Servidor",     width: "2fr",   sortable: true  },
            { key: "lastActivity",   label: "Ult. Ativ.",   width: "100px", sortable: true  },
            { key: "onlineRatio",    label: "Online",       width: "90px",  sortable: true  },
            { key: "unreadChannels", label: "Nao Lidos",    width: "75px",  sortable: true  },
            { key: "mentionCount",   label: "Mencoes",      width: "70px",  sortable: true  },
            { key: "channelCount",   label: "Canais",       width: "60px",  sortable: true  },
            { key: "memberCount",    label: "Membros",      width: "80px",  sortable: true  },
            { key: "serverAge",      label: "Criado em",    width: "90px",  sortable: true  },
            { key: "myRole",         label: "Meu Cargo",    width: "100px", sortable: true  },
            { key: "action",         label: "",             width: "65px",  sortable: false }
        ];
        return allColumns.filter(col => {
            if (col.key === "name" || col.key === "action") return true;
            return this.settings.columns[col.key] !== false;
        });
    }

    _buildTableHeader(container) {
        container.innerHTML = "";
        const columns = this._getColumns();
        container.style.gridTemplateColumns = columns.map(c => c.width).join(" ");

        for (const col of columns) {
            const cell = document.createElement("div");
            cell.className = "sa-th" + (col.sortable ? " sa-th-sortable" : "");

            const isSorted = this.settings.sortBy === col.key;
            const arrow = isSorted ? (this.settings.sortAsc ? " \u25B2" : " \u25BC") : "";
            cell.textContent = col.label + arrow;

            if (col.sortable) {
                cell.addEventListener("click", () => {
                    if (this.settings.sortBy === col.key) {
                        this.settings.sortAsc = !this.settings.sortAsc;
                    } else {
                        this.settings.sortBy = col.key;
                        this.settings.sortAsc = true;
                    }
                    this.saveSettings();
                    this._buildTableHeader(this._tableHeaderEl);
                    this.renderTable(this._tableBodyEl);
                    if (this._updateCountFn) this._updateCountFn();
                });
            }
            container.appendChild(cell);
        }
    }

    _getFilteredData() {
        let data = [...this._serverData];
        const now = Date.now();

        // Folder filter
        if (this._currentFolderFilter && this._currentFolderFilter !== "all") {
            if (this._currentFolderFilter === "none") {
                const inFolder = this._getGuildIdsInAnyFolder();
                data = data.filter(s => !inFolder.has(s.id));
            } else {
                const folders = this.getGuildFolders();
                const folder = folders.find(f => String(f.id) === String(this._currentFolderFilter));
                if (folder) {
                    const folderSet = new Set(folder.guildIds);
                    data = data.filter(s => folderSet.has(s.id));
                }
            }
        }

        switch (this._currentFilter) {
            case "hide7":
                data = data.filter(s => !s.lastActivityMs || (now - s.lastActivityMs) > 7 * 86400000);
                break;
            case "hide30":
                data = data.filter(s => !s.lastActivityMs || (now - s.lastActivityMs) > 30 * 86400000);
                break;
            case "dead30":
                data = data.filter(s => !s.lastActivityMs || (now - s.lastActivityMs) > 30 * 86400000);
                break;
            case "dead90":
                data = data.filter(s => !s.lastActivityMs || (now - s.lastActivityMs) > 90 * 86400000);
                break;
            case "unread":
                data = data.filter(s => s.unreadChannels > 0);
                break;
            case "mentions":
                data = data.filter(s => s.totalMentions > 0);
                break;
        }

        // Sort
        const key = this.settings.sortBy;
        const asc = this.settings.sortAsc;
        data.sort((a, b) => {
            let va, vb;
            switch (key) {
                case "name": va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
                case "lastActivity": va = a.lastActivityMs || 0; vb = b.lastActivityMs || 0; break;
                case "onlineRatio": va = a.onlineRatio; vb = b.onlineRatio; break;
                case "unreadChannels": va = a.unreadChannels; vb = b.unreadChannels; break;
                case "mentionCount": va = a.totalMentions; vb = b.totalMentions; break;
                case "channelCount": va = a.channelCount; vb = b.channelCount; break;
                case "memberCount": va = a.memberCount; vb = b.memberCount; break;
                case "serverAge": va = a.serverCreatedMs || 0; vb = b.serverCreatedMs || 0; break;
                case "myRole": va = a.myRole.toLowerCase(); vb = b.myRole.toLowerCase(); break;
                default: va = 0; vb = 0;
            }
            if (typeof va === "string") return asc ? va.localeCompare(vb) : vb.localeCompare(va);
            return asc ? va - vb : vb - va;
        });

        return data;
    }

    renderTable(container) {
        container.innerHTML = "";
        const columns = this._getColumns();
        const data = this._getFilteredData();

        if (data.length === 0) {
            container.innerHTML = `<div class="sa-empty">Nenhum servidor encontrado com este filtro.</div>`;
            return;
        }

        for (const server of data) {
            const row = document.createElement("div");
            row.className = "sa-row";
            row.style.gridTemplateColumns = columns.map(c => c.width).join(" ");

            for (const col of columns) {
                const cell = document.createElement("div");
                cell.className = "sa-td";

                switch (col.key) {
                    case "name": {
                        cell.className += " sa-td-name";
                        if (server.icon) {
                            const img = document.createElement("img");
                            img.className = "sa-server-icon";
                            img.src = server.icon;
                            img.onerror = () => { img.style.display = "none"; };
                            cell.appendChild(img);
                        } else {
                            const fb = document.createElement("div");
                            fb.className = "sa-server-icon-fallback";
                            fb.textContent = server.name.charAt(0).toUpperCase();
                            cell.appendChild(fb);
                        }
                        const nameSpan = document.createElement("span");
                        nameSpan.className = "sa-server-name";
                        nameSpan.textContent = server.name;
                        cell.appendChild(nameSpan);
                        if (server.isOwner) {
                            const badge = document.createElement("span");
                            badge.className = "sa-owner-badge";
                            badge.textContent = "Dono";
                            cell.appendChild(badge);
                        }
                        cell.style.cursor = "pointer";
                        cell.addEventListener("click", () => {
                            this.goToServer(server.id);
                            const overlay = document.querySelector(".sa-modal-overlay");
                            if (overlay) overlay.remove();
                        });
                        break;
                    }
                    case "lastActivity": {
                        const healthClass = this.getActivityColor(server.lastActivityMs);
                        const activityText = server.lastActivityMs
                            ? this.timestampToAge(server.lastActivityMs)
                            : "Sem dados";
                        const span = document.createElement("span");
                        span.className = healthClass;
                        span.textContent = activityText;
                        if (server.lastActiveChannel) span.title = `#${server.lastActiveChannel}`;
                        cell.appendChild(span);
                        break;
                    }
                    case "onlineRatio": {
                        const pct = Math.round(server.onlineRatio * 100);
                        const onlineClass = pct > 20 ? "sa-health-green" : pct > 5 ? "sa-health-yellow" : "sa-health-red";
                        const mainSpan = document.createElement("span");
                        mainSpan.className = onlineClass;
                        mainSpan.textContent = server.onlineCount > 0 ? `${pct}%` : "?";
                        cell.appendChild(mainSpan);
                        if (server.onlineCount > 0) {
                            const sub = document.createElement("span");
                            sub.className = "sa-sub";
                            sub.textContent = `${this._formatNumber(server.onlineCount)}/${this._formatNumber(server.memberCount)}`;
                            cell.appendChild(sub);
                        }
                        break;
                    }
                    case "unreadChannels":
                        cell.textContent = server.unreadChannels > 0 ? server.unreadChannels : "-";
                        if (server.unreadChannels > 0) cell.classList.add("sa-highlight");
                        break;
                    case "mentionCount":
                        cell.textContent = server.totalMentions > 0 ? server.totalMentions : "-";
                        if (server.totalMentions > 0) cell.classList.add("sa-mention-highlight");
                        break;
                    case "channelCount":
                        cell.textContent = server.channelCount;
                        break;
                    case "memberCount":
                        cell.textContent = this._formatNumber(server.memberCount);
                        break;
                    case "serverAge":
                        cell.textContent = server.serverCreatedMs
                            ? new Date(server.serverCreatedMs).toLocaleDateString("pt-BR", { month: "short", year: "numeric" })
                            : "?";
                        break;
                    case "myRole":
                        cell.textContent = server.myRole;
                        cell.title = server.myRole;
                        cell.classList.add("sa-td-role");
                        break;
                    case "action": {
                        if (!server.isOwner) {
                            const leaveBtn = document.createElement("button");
                            leaveBtn.className = "sa-leave-btn";
                            leaveBtn.textContent = "Sair";
                            leaveBtn.addEventListener("click", (e) => {
                                e.stopPropagation();
                                this.showLeaveConfirmation(server, () => {
                                    this.renderTable(container);
                                    if (this._updateCountFn) this._updateCountFn();
                                });
                            });
                            cell.appendChild(leaveBtn);
                        } else {
                            const lock = document.createElement("span");
                            lock.className = "sa-owner-lock";
                            lock.title = "Voce e dono deste servidor";
                            lock.textContent = "\uD83D\uDD12";
                            cell.appendChild(lock);
                        }
                        break;
                    }
                }
                row.appendChild(cell);
            }
            container.appendChild(row);
        }
    }

    // ========== UI: CONFIRMACAO ==========

    showLeaveConfirmation(server, onSuccess) {
        const overlay = document.querySelector(".sa-modal-overlay");
        if (!overlay) return;

        // Remove previous confirmation if any
        const prev = overlay.querySelector(".sa-confirm-overlay");
        if (prev) prev.remove();

        const confirm = document.createElement("div");
        confirm.className = "sa-confirm-overlay";

        const box = document.createElement("div");
        box.className = "sa-confirm-box";

        const h3 = document.createElement("h3");
        h3.textContent = `Sair de "${server.name}"?`;

        const p = document.createElement("p");
        p.textContent = "Voce perdera acesso a todos os canais e mensagens deste servidor.";

        const actions = document.createElement("div");
        actions.className = "sa-confirm-actions";

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "sa-btn sa-confirm-cancel";
        cancelBtn.textContent = "Cancelar";
        cancelBtn.addEventListener("click", () => confirm.remove());

        const leaveBtn = document.createElement("button");
        leaveBtn.className = "sa-confirm-leave";
        leaveBtn.textContent = "Sair do Servidor";
        leaveBtn.addEventListener("click", async () => {
            leaveBtn.disabled = true;
            leaveBtn.textContent = "Saindo...";
            const success = await this.leaveServer(server.id, server.name);
            confirm.remove();
            if (success && onSuccess) onSuccess();
        });

        actions.append(cancelBtn, leaveBtn);
        box.append(h3, p, actions);
        confirm.appendChild(box);
        confirm.addEventListener("click", e => {
            if (e.target === confirm) confirm.remove();
        });
        overlay.appendChild(confirm);
    }

    // ========== HELPERS ==========

    _formatNumber(n) {
        if (!n && n !== 0) return "?";
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
        return String(n);
    }

    // ========== STYLES ==========

    injectStyles() {
        BdApi.DOM.addStyle(this.styleId, `
            /* Toolbar button */
            .server-activity-toolbar-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                margin: 0 8px;
                cursor: pointer;
                color: var(--interactive-normal, #b5bac1);
                transition: color 0.15s;
            }
            .server-activity-toolbar-btn:hover {
                color: var(--interactive-hover, #fff);
            }

            /* Modal overlay */
            .sa-modal-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            /* Modal */
            .sa-modal {
                background: var(--modal-background, var(--background-primary, #313338));
                border-radius: 8px;
                width: 920px;
                max-width: 95vw;
                max-height: 85vh;
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                overflow: hidden;
            }

            /* Header */
            .sa-modal-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 16px 20px;
                border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                background: var(--modal-background, var(--background-secondary, #2b2d31));
            }
            .sa-modal-header h2 {
                margin: 0;
                font-size: 18px;
                font-weight: 700;
                color: var(--header-primary, #f2f3f5);
            }
            .sa-close {
                font-size: 24px;
                cursor: pointer;
                color: var(--interactive-normal, #b5bac1);
                line-height: 1;
                padding: 4px 8px;
                border-radius: 4px;
            }
            .sa-close:hover {
                color: var(--interactive-hover, #fff);
                background: var(--background-modifier-hover, rgba(255,255,255,0.1));
            }

            /* Controls */
            .sa-controls {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 10px 20px;
                border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
            }
            .sa-btn {
                padding: 6px 14px;
                border-radius: 4px;
                border: none;
                background: var(--brand-experiment, #5865f2);
                color: #fff;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.15s;
            }
            .sa-btn:hover {
                background: var(--brand-experiment-560, #4752c4);
            }
            .sa-filter-select {
                padding: 6px 10px;
                border-radius: 4px;
                border: 1px solid var(--background-tertiary, #1e1f22);
                background: var(--input-background, var(--background-tertiary, #1e1f22));
                color: var(--text-normal, #f2f3f5);
                font-size: 13px;
                cursor: pointer;
            }
            .sa-filter-select option {
                background: var(--background-secondary, #2b2d31);
                color: var(--text-normal, #f2f3f5);
            }
            .sa-server-count {
                font-size: 13px;
                color: var(--text-muted, #949ba4);
                margin-left: auto;
            }

            /* Table wrapper */
            .sa-table-wrapper {
                flex: 1;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                min-height: 0;
            }

            /* Table header */
            .sa-table-header {
                display: grid;
                padding: 8px 16px;
                background: var(--background-secondary, #2b2d31);
                border-bottom: 2px solid var(--background-modifier-accent, #3f4147);
                flex-shrink: 0;
            }
            .sa-th {
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                color: var(--text-muted, #949ba4);
                padding: 4px 6px;
                user-select: none;
            }
            .sa-th-sortable {
                cursor: pointer;
                transition: color 0.1s;
            }
            .sa-th-sortable:hover {
                color: var(--text-normal, #f2f3f5);
            }

            /* Table body */
            .sa-table-body {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
            }

            /* Rows */
            .sa-row {
                display: grid;
                padding: 5px 16px;
                border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                align-items: center;
                transition: background 0.1s;
            }
            .sa-row:hover {
                background: var(--background-modifier-hover, rgba(255,255,255,0.06));
            }

            /* Cells */
            .sa-td {
                padding: 4px 6px;
                font-size: 13px;
                color: var(--text-normal, #dbdee1);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .sa-td-name {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            /* Server icon */
            .sa-server-icon {
                width: 24px;
                height: 24px;
                border-radius: 50%;
                flex-shrink: 0;
                object-fit: cover;
            }
            .sa-server-icon-fallback {
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background: var(--brand-experiment, #5865f2);
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                font-size: 12px;
                flex-shrink: 0;
            }

            /* Server name */
            .sa-server-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: var(--text-normal, #dbdee1);
            }

            /* Health indicators */
            .sa-health-green { color: var(--status-positive, #23a55a); font-weight: 600; }
            .sa-health-yellow { color: var(--status-warning, #f0b232); font-weight: 600; }
            .sa-health-red { color: var(--status-danger, #f23f43); font-weight: 600; }

            /* Sub-text */
            .sa-sub {
                font-size: 10px;
                color: var(--text-muted, #949ba4);
                display: block;
                line-height: 1.2;
            }

            /* Highlights */
            .sa-highlight { color: var(--text-normal, #dbdee1); font-weight: 600; }
            .sa-mention-highlight { color: var(--status-danger, #f23f43); font-weight: 700; }

            /* Owner badge */
            .sa-owner-badge {
                font-size: 10px;
                padding: 1px 5px;
                border-radius: 3px;
                background: rgba(250, 168, 26, 0.15);
                color: #faa81a;
                font-weight: 600;
                flex-shrink: 0;
            }

            /* Owner lock */
            .sa-owner-lock {
                font-size: 14px;
                display: flex;
                justify-content: center;
                cursor: default;
            }

            /* Leave button */
            .sa-leave-btn {
                padding: 3px 10px;
                border-radius: 4px;
                border: 1px solid var(--status-danger, #f23f43);
                background: transparent;
                color: var(--status-danger, #f23f43);
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.15s, color 0.15s;
            }
            .sa-leave-btn:hover {
                background: var(--status-danger, #f23f43);
                color: #fff;
            }
            .sa-leave-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            /* Role column */
            .sa-td-role {
                max-width: 100px;
            }

            /* Empty state */
            .sa-empty {
                padding: 40px 20px;
                text-align: center;
                color: var(--text-muted, #949ba4);
                font-size: 14px;
            }

            /* Confirmation overlay */
            .sa-confirm-overlay {
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                z-index: 10;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 8px;
            }
            .sa-confirm-box {
                background: var(--modal-background, var(--background-primary, #313338));
                border-radius: 8px;
                padding: 24px;
                max-width: 400px;
                text-align: center;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            }
            .sa-confirm-box h3 {
                margin: 0 0 8px 0;
                font-size: 16px;
                color: var(--header-primary, #f2f3f5);
                word-break: break-word;
            }
            .sa-confirm-box p {
                margin: 0 0 16px 0;
                font-size: 13px;
                color: var(--text-muted, #949ba4);
            }
            .sa-confirm-actions {
                display: flex;
                gap: 10px;
                justify-content: center;
            }
            .sa-confirm-cancel {
                background: transparent;
                border: 1px solid var(--background-modifier-accent, #3f4147);
                color: var(--text-normal, #dbdee1);
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
            }
            .sa-confirm-cancel:hover {
                background: var(--background-modifier-hover, rgba(255,255,255,0.06));
            }
            .sa-confirm-leave {
                background: var(--status-danger, #f23f43);
                color: #fff;
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                font-weight: 600;
                font-size: 13px;
                transition: opacity 0.15s;
            }
            .sa-confirm-leave:hover {
                opacity: 0.9;
            }
            .sa-confirm-leave:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            /* Footer */
            .sa-modal-footer {
                padding: 8px 20px;
                font-size: 11px;
                color: var(--text-muted, #949ba4);
                border-top: 1px solid var(--background-modifier-accent, #3f4147);
                text-align: right;
                flex-shrink: 0;
            }

            /* Scrollbar */
            .sa-table-body::-webkit-scrollbar {
                width: 8px;
            }
            .sa-table-body::-webkit-scrollbar-thumb {
                background: var(--background-tertiary, #1e1f22);
                border-radius: 4px;
            }
            .sa-table-body::-webkit-scrollbar-track {
                background: transparent;
            }
        `);
    }

    removeStyles() {
        BdApi.DOM.removeStyle(this.styleId);
    }
};
