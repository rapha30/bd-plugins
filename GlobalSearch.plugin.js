/**
 * @name GlobalSearch
 * @author Rapha
 * @description Busca mensagens em todos os servidores (ou servidores selecionados) de uma vez. Resultados ordenados do mais recente ao mais antigo.
 * @version 1.0.0
 * @source https://github.com/rapha30/bd-plugins
 * @updateUrl https://raw.githubusercontent.com/rapha30/bd-plugins/master/GlobalSearch.plugin.js
 */

module.exports = class GlobalSearch {
    constructor(meta) {
        this.meta = meta;
        this.settings = {
            maxResultsPerGuild: 25,
            selectedGuilds: [],
            searchDelay: 300,
            parallelSearches: 3,
            viewMode: "traditional", // compact, traditional, detailed
            excludeWords: ["buy"],
            fuzzyTerms: [],
            autoRefresh: false,
            autoRefreshInterval: 300000, // 5 min default
            autoForwardMessage: true
        };
        this.styleId = "global-search-styles";
        this.buttonId = "global-search-btn";
        this.modules = {};
        this.observer = null;
        this._keyHandler = null;
        this._blurHandler = null;
        // Background search state
        this._lastResults = null;
        this._lastQuery = "";
        this._isSearching = false;
        this._searchProgress = null;
        // Search history
        this._searchHistory = [];
        // Archived searches
        this._archivedSearches = [];
        // Pause/resume state
        this._isPaused = false;
        this._pausedState = null;
        // Channel filter state (persists across re-renders)
        this._activeChannelFilter = null;
        this._excludedChannels = new Set();
    }

    // ========== LOGGING ==========

    _initLog() {
        try {
            this._fs = require("fs");
            this._logPath = "C:\\Users\\rapha\\Downloads\\CLAUDE AI\\search-plugin-discord\\GlobalSearch.log";
            this._fs.writeFileSync(this._logPath, `[GlobalSearch] Log iniciado: ${new Date().toISOString()}\n`);
        } catch (e) {
            console.error("[GlobalSearch] Nao conseguiu iniciar log:", e);
            this._fs = null;
        }
    }

    log(msg) {
        const line = `[${new Date().toLocaleTimeString("pt-BR")}] ${msg}`;
        console.log(`[GlobalSearch] ${msg}`);
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
            this.setupKeybind();
            this.loadHistory();
            this.loadArchived();
            this.setupAutoRefresh();
            this.log("Plugin ativado com sucesso!");
            BdApi.UI.showToast("GlobalSearch ativado! Use Ctrl+Shift+F para buscar.", { type: "success" });
        } catch (e) {
            this.log(`ERRO no start(): ${e.message}\n${e.stack}`);
        }
    }

    stop() {
        this._cancelSearch = true;
        this._isSearching = false;
        this._isPaused = false;
        this._pausedState = null;
        this.removeButton();
        this.removeStyles();
        this.removeKeybind();
        this.removeAutoRefresh();
        const overlay = document.querySelector(".gs-modal-overlay");
        if (overlay) overlay.remove();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        BdApi.UI.showToast("GlobalSearch desativado!", { type: "info" });
    }

    // ========== SETTINGS ==========

    loadSettings() {
        const saved = BdApi.Data.load(this.meta.name, "settings");
        if (saved) this.settings = Object.assign(this.settings, saved);
    }

    saveSettings() {
        BdApi.Data.save(this.meta.name, "settings", this.settings);
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.padding = "16px";
        panel.style.color = "var(--text-normal)";

        // Max results per guild
        const maxLabel = document.createElement("label");
        maxLabel.textContent = "Resultados por servidor (max):";
        maxLabel.style.display = "block";
        maxLabel.style.marginBottom = "4px";
        maxLabel.style.fontWeight = "600";

        const maxInput = document.createElement("input");
        maxInput.type = "number";
        maxInput.min = "1";
        maxInput.max = "100";
        maxInput.value = this.settings.maxResultsPerGuild;
        maxInput.style.cssText = "width:80px;padding:6px 8px;border-radius:4px;border:1px solid var(--background-tertiary);background:var(--background-secondary);color:var(--text-normal);";
        maxInput.addEventListener("change", () => {
            this.settings.maxResultsPerGuild = parseInt(maxInput.value) || 25;
            this.saveSettings();
        });

        // Delay between requests
        const delayLabel = document.createElement("label");
        delayLabel.textContent = "Delay entre buscas (ms):";
        delayLabel.style.display = "block";
        delayLabel.style.marginTop = "12px";
        delayLabel.style.marginBottom = "4px";
        delayLabel.style.fontWeight = "600";

        const delayInput = document.createElement("input");
        delayInput.type = "number";
        delayInput.min = "200";
        delayInput.max = "3000";
        delayInput.value = this.settings.searchDelay;
        delayInput.style.cssText = "width:80px;padding:6px 8px;border-radius:4px;border:1px solid var(--background-tertiary);background:var(--background-secondary);color:var(--text-normal);";
        delayInput.addEventListener("change", () => {
            this.settings.searchDelay = parseInt(delayInput.value) || 600;
            this.saveSettings();
        });

        panel.append(maxLabel, maxInput, delayLabel, delayInput);
        return panel;
    }

    // ========== DISCORD MODULES ==========

    cacheModules() {
        this.modules.GuildStore = BdApi.Webpack.getStore("GuildStore");
        this.modules.ChannelStore = BdApi.Webpack.getStore("ChannelStore");
        this.modules.UserStore = BdApi.Webpack.getStore("UserStore");
        this.modules.SelectedGuildStore = BdApi.Webpack.getStore("SelectedGuildStore");

        // Token module
        this.modules.TokenModule = BdApi.Webpack.getModule(m => m?.getToken && m?.getEmail, { searchExports: false })
            || BdApi.Webpack.getByKeys("getToken", "getEmail");

        // Guild folders store
        this.modules.SortedGuildStore = BdApi.Webpack.getStore("SortedGuildStore");

        // Navigation module to jump to messages
        this.modules.NavigationUtils = BdApi.Webpack.getByKeys("transitionTo", "transitionToGuild");

        // Message jump module — selectChannel + focusMessage
        this.modules.ChannelActions = BdApi.Webpack.getByKeys("selectChannel", "selectPrivateChannel")
            || BdApi.Webpack.getByKeys("selectChannel");
        this.modules.MessageActions = BdApi.Webpack.getByKeys("jumpToMessage", "fetchMessages")
            || BdApi.Webpack.getByKeys("jumpToMessage");

        this.log(`Modules: GuildStore=${!!this.modules.GuildStore} ChannelStore=${!!this.modules.ChannelStore} TokenModule=${!!this.modules.TokenModule} SortedGuild=${!!this.modules.SortedGuildStore} Nav=${!!this.modules.NavigationUtils} ChanActions=${!!this.modules.ChannelActions} MsgActions=${!!this.modules.MessageActions}`);
    }

    // ========== API ==========

    getToken() {
        // Method 1: via cached TokenModule
        if (this.modules.TokenModule?.getToken) {
            return this.modules.TokenModule.getToken();
        }
        // Method 2: via AuthenticationStore
        const authStore = BdApi.Webpack.getStore("AuthenticationStore");
        if (authStore?.getToken) {
            return authStore.getToken();
        }
        // Method 3: via webpack chunk search
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

    async discordFetch(url) {
        const token = this.getToken();
        if (!token) {
            this.log("ERRO: Token nao encontrado!");
            return { ok: false, status: 401, json: async () => ({}) };
        }
        const resp = await fetch(url, {
            headers: {
                "Authorization": token,
                "Content-Type": "application/json"
            }
        });
        this.log(`Fetch ${url.substring(40, 100)}... -> ${resp.status}`);
        return resp;
    }

    async discordPost(url, body) {
        const token = this.getToken();
        if (!token) {
            this.log("ERRO: Token nao encontrado!");
            return { ok: false, status: 401, json: async () => ({}) };
        }
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });
        this.log(`POST ${url.substring(40, 100)}... -> ${resp.status}`);
        return resp;
    }

    async searchGuild(guildId, query, offset = 0, minSnowflake = null) {
        const limit = this.settings.maxResultsPerGuild;
        let url = `https://discord.com/api/v9/guilds/${guildId}/messages/search?content=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
        if (minSnowflake) {
            url += `&min_id=${minSnowflake}`;
        }

        try {
            const resp = await this.discordFetch(url);

            if (resp.status === 202) {
                // Index not ready, wait and retry once
                await this.sleep(2000);
                return this.searchGuild(guildId, query, offset, minSnowflake);
            }

            if (resp.status === 429) {
                // Rate limited
                const data = await resp.json();
                const retryAfter = (data.retry_after || 2) * 1000;
                await this.sleep(retryAfter);
                return this.searchGuild(guildId, query, offset, minSnowflake);
            }

            if (!resp.ok) return [];

            const data = await resp.json();
            if (!data.messages) return [];

            const guild = this.modules.GuildStore.getGuild(guildId);
            return data.messages.map(msgGroup => {
                const msg = msgGroup[0]; // First message in the context group
                const channel = this.modules.ChannelStore.getChannel(msg.channel_id);
                return {
                    id: msg.id,
                    content: msg.content,
                    author: msg.author.global_name || msg.author.username,
                    authorId: msg.author.id,
                    authorAvatar: msg.author.avatar
                        ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png?size=40`
                        : null,
                    timestamp: msg.timestamp,
                    guildId: guildId,
                    guildName: guild ? guild.name : "Desconhecido",
                    guildIcon: guild && guild.icon ? `https://cdn.discordapp.com/icons/${guildId}/${guild.icon}.png?size=32` : null,
                    channelId: msg.channel_id,
                    channelName: channel ? channel.name : "desconhecido",
                    attachments: msg.attachments || [],
                    embeds: msg.embeds || []
                };
            });
        } catch (err) {
            this.log(`ERRO servidor ${guildId}: ${err.message}`);
            return [];
        }
    }

    async searchMultipleGuilds(guildIds, query, minSnowflake = null, excludeWords = [], customVariants = []) {
        this._isSearching = true;
        this._cancelSearch = false;
        this._isPaused = false;
        this._pausedState = null;
        this._lastQuery = query;
        this._lastResults = [];
        this._excludeWords = excludeWords;
        this._filteredCount = 0;
        this._searchProgress = { completed: 0, total: guildIds.length, results: 0 };
        // Build query variants: main query + custom user variants
        const variantSet = new Set([query]);
        for (const v of customVariants) {
            if (v.toLowerCase() !== query.toLowerCase()) variantSet.add(v);
        }
        const queryVariants = [...variantSet];
        this.log(`Iniciando busca: "${query}" (${queryVariants.length} variantes: ${queryVariants.join(" | ")}) em ${guildIds.length} servidores (paralelo: ${this.settings.parallelSearches}) minSnowflake=${minSnowflake} excluir=[${excludeWords.join(",")}]`);

        const seenIds = new Set(); // Deduplicate results across variants

        // Process guilds in parallel batches
        const batchSize = this.settings.parallelSearches || 3;
        for (let i = 0; i < guildIds.length; i += batchSize) {
            if (this._cancelSearch) break;
            if (this._isPaused) {
                this._pausedState = {
                    guildIds, query, minSnowflake, excludeWords, customVariants,
                    seenIds, batchIndex: i,
                    partialResults: this._lastResults,
                    filteredCount: this._filteredCount
                };
                this._isSearching = false;
                this.log(`Busca pausada no batch ${i}/${guildIds.length}`);
                this._updateModalPaused();
                return;
            }

            const batch = guildIds.slice(i, i + batchSize);

            // For each guild in the batch, search all query variants
            const batchResults = await Promise.all(
                batch.map(async guildId => {
                    const allResults = [];
                    for (const variant of queryVariants) {
                        if (this._cancelSearch || this._isPaused) break;
                        const results = await this.searchGuild(guildId, variant, 0, minSnowflake);
                        allResults.push(...results);
                        // Small delay between variant searches for same guild
                        if (queryVariants.length > 1) await this.sleep(100);
                    }
                    return allResults;
                })
            );

            // Deduplicate and apply filter incrementally
            const newMessages = [];
            for (const results of batchResults) {
                for (const msg of results) {
                    if (!seenIds.has(msg.id)) {
                        seenIds.add(msg.id);
                        newMessages.push(msg);
                    }
                }
            }

            // Filter new batch immediately
            const filtered = this._filterResults(newMessages, this._excludeWords);
            this._filteredCount += (newMessages.length - filtered.length);
            this._lastResults.push(...filtered);

            // Sort all results so far by timestamp descending
            this._lastResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            this._searchProgress.completed += batch.length;
            this._searchProgress.results = this._lastResults.length;

            // Update modal UI with progress AND partial results
            this._updateModalProgress();
            this._updateModalResults();

            // Delay between batches to avoid rate limiting
            if (i + batchSize < guildIds.length) {
                await this.sleep(this.settings.searchDelay);
            }
        }

        this._isSearching = false;
        this.log(`Busca finalizada: ${this._lastResults.length} resultados (${this._filteredCount} filtrados)`);

        // Final update
        this._updateModalDone();

        if (!this._cancelSearch) {
            // Save to history
            this.addToHistory({
                query: query,
                variants: customVariants,
                excludeWords: excludeWords,
                guildIds: guildIds,
                timestamp: Date.now(),
                resultCount: this._lastResults.length,
                results: this._lastResults,
                channelFilter: this._activeChannelFilter,
                excludedChannels: [...this._excludedChannels]
            });
            BdApi.UI.showToast(`Busca concluida! ${this._lastResults.length} resultado(s)${this._filteredCount > 0 ? ` (${this._filteredCount} filtrados)` : ""}.`, { type: "success" });
        }
    }

    _updateModalProgress() {
        const progressEl = document.querySelector(".gs-progress");
        if (!progressEl || !this._searchProgress) return;
        const { completed, total, results } = this._searchProgress;
        const filtered = this._filteredCount || 0;
        progressEl.style.display = "block";
        progressEl.innerHTML = `
            <div class="gs-progress-bar-bg">
                <div class="gs-progress-bar" style="width:${(completed/total)*100}%"></div>
            </div>
            <div class="gs-progress-info">
                <span>Buscando: ${completed}/${total} servidores | ${results} resultados${filtered > 0 ? ` (${filtered} filtrados)` : ""}</span>
                <div style="display:flex;gap:6px;">
                    <button class="gs-pause-btn" id="gs-pause-search">Pausar</button>
                    <button class="gs-cancel-btn" id="gs-cancel-search">Cancelar</button>
                </div>
            </div>
        `;
        // Attach pause handler
        const pauseBtn = progressEl.querySelector("#gs-pause-search");
        if (pauseBtn) {
            pauseBtn.addEventListener("click", () => {
                this._isPaused = true;
                this.log("Busca pausada pelo usuario");
                BdApi.UI.showToast("Busca pausada!", { type: "info" });
            });
        }
        // Attach cancel handler
        const cancelBtn = progressEl.querySelector("#gs-cancel-search");
        if (cancelBtn) {
            cancelBtn.addEventListener("click", () => {
                this._cancelSearch = true;
                this._isSearching = false;
                this._isPaused = false;
                this._pausedState = null;
                this.log("Busca cancelada pelo usuario");
                this._updateModalDone(true);
                BdApi.UI.showToast("Busca cancelada!", { type: "warning" });
            });
        }
    }

    _updateModalPaused() {
        const progressEl = document.querySelector(".gs-progress");
        const searchBtn = document.querySelector(".gs-search-btn");

        if (searchBtn) {
            searchBtn.disabled = false;
            searchBtn.textContent = "Buscar";
        }

        if (progressEl && this._searchProgress) {
            const { completed, total, results } = this._searchProgress;
            progressEl.style.display = "block";
            progressEl.innerHTML = `
                <div class="gs-progress-bar-bg">
                    <div class="gs-progress-bar gs-progress-bar-paused" style="width:${(completed/total)*100}%"></div>
                </div>
                <div class="gs-progress-info">
                    <span>Pausado: ${completed}/${total} servidores | ${results} resultados</span>
                    <div style="display:flex;gap:6px;">
                        <button class="gs-resume-btn" id="gs-resume-search">Continuar</button>
                        <button class="gs-cancel-btn" id="gs-cancel-paused">Cancelar</button>
                    </div>
                </div>
            `;
            const resumeBtn = progressEl.querySelector("#gs-resume-search");
            if (resumeBtn) {
                resumeBtn.addEventListener("click", () => {
                    this.resumeSearch();
                });
            }
            const cancelBtn = progressEl.querySelector("#gs-cancel-paused");
            if (cancelBtn) {
                cancelBtn.addEventListener("click", () => {
                    this._isPaused = false;
                    this._pausedState = null;
                    this._cancelSearch = true;
                    this.log("Busca pausada cancelada");
                    this._updateModalDone(true);
                    BdApi.UI.showToast("Busca cancelada!", { type: "warning" });
                });
            }
        }

        // Also render partial results
        this._updateModalResults();
    }

    async resumeSearch() {
        if (!this._pausedState) {
            BdApi.UI.showToast("Nenhuma busca pausada.", { type: "warning" });
            return;
        }
        const state = this._pausedState;
        this._pausedState = null;
        this._isPaused = false;
        this._isSearching = true;
        this._cancelSearch = false;
        this._lastResults = state.partialResults;
        this._filteredCount = state.filteredCount;
        this._lastQuery = state.query;
        this._excludeWords = state.excludeWords;

        const { guildIds, query, minSnowflake, excludeWords, customVariants, seenIds, batchIndex } = state;

        const variantSet = new Set([query]);
        for (const v of customVariants) {
            if (v.toLowerCase() !== query.toLowerCase()) variantSet.add(v);
        }
        const queryVariants = [...variantSet];

        this._searchProgress = {
            completed: batchIndex,
            total: guildIds.length,
            results: this._lastResults.length
        };

        const batchSize = this.settings.parallelSearches || 3;
        this.log(`Retomando busca: "${query}" a partir do batch ${batchIndex}/${guildIds.length}`);

        // Disable search button
        const searchBtn = document.querySelector(".gs-search-btn");
        if (searchBtn) {
            searchBtn.disabled = true;
            searchBtn.textContent = "Buscando...";
        }

        for (let i = batchIndex; i < guildIds.length; i += batchSize) {
            if (this._cancelSearch) break;
            if (this._isPaused) {
                this._pausedState = {
                    guildIds, query, minSnowflake, excludeWords, customVariants,
                    seenIds, batchIndex: i,
                    partialResults: this._lastResults,
                    filteredCount: this._filteredCount
                };
                this._isSearching = false;
                this.log(`Busca pausada novamente no batch ${i}/${guildIds.length}`);
                this._updateModalPaused();
                return;
            }

            const batch = guildIds.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async guildId => {
                    const allResults = [];
                    for (const variant of queryVariants) {
                        if (this._cancelSearch || this._isPaused) break;
                        const results = await this.searchGuild(guildId, variant, 0, minSnowflake);
                        allResults.push(...results);
                        if (queryVariants.length > 1) await this.sleep(100);
                    }
                    return allResults;
                })
            );

            const newMessages = [];
            for (const results of batchResults) {
                for (const msg of results) {
                    if (!seenIds.has(msg.id)) {
                        seenIds.add(msg.id);
                        newMessages.push(msg);
                    }
                }
            }

            const filtered = this._filterResults(newMessages, this._excludeWords);
            this._filteredCount += (newMessages.length - filtered.length);
            this._lastResults.push(...filtered);
            this._lastResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            this._searchProgress.completed += batch.length;
            this._searchProgress.results = this._lastResults.length;

            this._updateModalProgress();
            this._updateModalResults();

            if (i + batchSize < guildIds.length) {
                await this.sleep(this.settings.searchDelay);
            }
        }

        this._isSearching = false;
        this.log(`Busca retomada finalizada: ${this._lastResults.length} resultados (${this._filteredCount} filtrados)`);
        this._updateModalDone();

        if (!this._cancelSearch) {
            this.addToHistory({
                query, variants: customVariants, excludeWords,
                guildIds, timestamp: Date.now(),
                resultCount: this._lastResults.length,
                results: this._lastResults,
                channelFilter: this._activeChannelFilter,
                excludedChannels: [...this._excludedChannels]
            });
            BdApi.UI.showToast(`Busca concluida! ${this._lastResults.length} resultado(s)${this._filteredCount > 0 ? ` (${this._filteredCount} filtrados)` : ""}.`, { type: "success" });
        }
    }

    _updateModalResults() {
        const resultsEl = document.querySelector(".gs-results");
        if (!resultsEl || !this._lastResults) return;
        const overlay = document.querySelector(".gs-modal-overlay");
        if (!overlay) return;
        this.renderResults(resultsEl, this._lastResults, overlay);
    }

    _updateModalDone(cancelled = false) {
        const progressEl = document.querySelector(".gs-progress");
        const searchBtn = document.querySelector(".gs-search-btn");

        if (searchBtn) {
            searchBtn.disabled = false;
            searchBtn.textContent = "Buscar";
        }

        if (progressEl && this._lastResults) {
            const filtered = this._filteredCount || 0;
            const status = cancelled ? "Busca cancelada" : "Busca concluida";
            progressEl.innerHTML = `<span>${status}! ${this._lastResults.length} resultado(s)${filtered > 0 ? ` (${filtered} filtrados)` : ""}.</span>`;
        }

        // Final render of results
        this._updateModalResults();
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ========== SEARCH HISTORY ==========

    loadHistory() {
        this._searchHistory = BdApi.Data.load(this.meta.name, "history") || [];
        this.log(`Historico carregado: ${this._searchHistory.length} entradas`);
    }

    saveHistory() {
        // Keep max 50 entries
        if (this._searchHistory.length > 50) {
            this._searchHistory = this._searchHistory.slice(0, 50);
        }
        BdApi.Data.save(this.meta.name, "history", this._searchHistory);
    }

    addToHistory(entry) {
        // entry: { query, variants, excludeWords, guildIds, period, timestamp, resultCount, results }
        // Remove duplicate with same query if exists
        this._searchHistory = this._searchHistory.filter(h => h.query !== entry.query);
        // Add to front
        this._searchHistory.unshift(entry);
        this.saveHistory();
        this.log(`Historico: adicionado "${entry.query}" (${entry.resultCount} resultados)`);
    }

    clearHistory() {
        this._searchHistory = [];
        BdApi.Data.save(this.meta.name, "history", []);
        this.log("Historico limpo");
    }

    getHistoryEntry(query) {
        return this._searchHistory.find(h => h.query === query);
    }

    deleteHistoryEntry(query) {
        this._searchHistory = this._searchHistory.filter(h => h.query !== query);
        this.saveHistory();
        this.log(`Historico: removido "${query}"`);
    }

    // ========== ARCHIVED SEARCHES ==========

    loadArchived() {
        this._archivedSearches = BdApi.Data.load(this.meta.name, "archived") || [];
        this.log(`Arquivados carregados: ${this._archivedSearches.length} entradas`);
    }

    saveArchived() {
        BdApi.Data.save(this.meta.name, "archived", this._archivedSearches);
    }

    archiveSearch(entry) {
        if (this._archivedSearches.some(a => a.query === entry.query)) {
            BdApi.UI.showToast(`"${entry.query}" ja esta arquivado.`, { type: "warning" });
            return;
        }
        const archived = { ...entry, archivedAt: Date.now() };
        this._archivedSearches.unshift(archived);
        this.saveArchived();
        this.log(`Arquivado: "${entry.query}"`);
    }

    unarchiveSearch(query) {
        this._archivedSearches = this._archivedSearches.filter(a => a.query !== query);
        this.saveArchived();
        this.log(`Desarquivado: "${query}"`);
    }

    // ========== STORAGE SIZE ==========

    getStorageSize() {
        const histJson = JSON.stringify(this._searchHistory || []);
        const archJson = JSON.stringify(this._archivedSearches || []);
        const histBytes = new Blob([histJson]).size;
        const archBytes = new Blob([archJson]).size;
        const totalBytes = histBytes + archBytes;
        const formatSize = (bytes) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        };
        return {
            history: formatSize(histBytes),
            archived: formatSize(archBytes),
            total: formatSize(totalBytes),
            historyBytes: histBytes,
            archivedBytes: archBytes,
            totalBytes: totalBytes
        };
    }

    // ========== AUTO REFRESH ==========

    setupAutoRefresh() {
        this._blurHandler = () => {
            if (!this.settings.autoRefresh) return;
            if (this._isSearching) return;
            // Find the most recent history entry to refresh
            const lastEntry = this._searchHistory[0];
            if (!lastEntry) return;
            this.log(`Auto-refresh: janela perdeu foco, atualizando "${lastEntry.query}"...`);
            this._runAutoRefresh(lastEntry);
        };
        window.addEventListener("blur", this._blurHandler);
    }

    removeAutoRefresh() {
        if (this._blurHandler) {
            window.removeEventListener("blur", this._blurHandler);
            this._blurHandler = null;
        }
    }

    async _runAutoRefresh(historyEntry, onProgress) {
        if (this._isSearching) return;
        // Build min_id from the history entry timestamp (search only messages newer than last search)
        const DISCORD_EPOCH = 1420070400000;
        const lastSearchTime = historyEntry.timestamp;
        const minSnowflake = String(BigInt(lastSearchTime - DISCORD_EPOCH) << 22n);

        // Build variants
        const customVariants = historyEntry.variants || [];

        this.log(`Auto-refresh: buscando desde ${new Date(lastSearchTime).toLocaleTimeString("pt-BR")}`);

        // Run the search but keep old results and merge
        this._isSearching = true;
        this._cancelSearch = false;
        const oldResults = historyEntry.results || [];
        const seenIds = new Set(oldResults.map(r => r.id));

        const variantSet = new Set([historyEntry.query]);
        for (const v of customVariants) {
            if (v.toLowerCase() !== historyEntry.query.toLowerCase()) variantSet.add(v);
        }
        const queryVariants = [...variantSet];

        const guildIds = historyEntry.guildIds || [];
        const excludeWords = historyEntry.excludeWords || [];
        let newCount = 0;

        const batchSize = this.settings.parallelSearches || 3;
        for (let i = 0; i < guildIds.length; i += batchSize) {
            if (this._cancelSearch) break;
            const batch = guildIds.slice(i, i + batchSize);
            const done = Math.min(i + batchSize, guildIds.length);
            if (onProgress) onProgress(done, guildIds.length, newCount);
            const batchResults = await Promise.all(
                batch.map(async guildId => {
                    const allResults = [];
                    for (const variant of queryVariants) {
                        if (this._cancelSearch) break;
                        const results = await this.searchGuild(guildId, variant, 0, minSnowflake);
                        allResults.push(...results);
                        if (queryVariants.length > 1) await this.sleep(100);
                    }
                    return allResults;
                })
            );
            for (const results of batchResults) {
                for (const msg of results) {
                    if (!seenIds.has(msg.id)) {
                        seenIds.add(msg.id);
                        const filtered = this._filterResults([msg], excludeWords);
                        if (filtered.length > 0) {
                            oldResults.push(msg);
                            newCount++;
                        }
                    }
                }
            }
            if (i + batchSize < guildIds.length) {
                await this.sleep(this.settings.searchDelay);
            }
        }

        this._isSearching = false;

        if (newCount > 0) {
            // Sort and update history
            oldResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            historyEntry.results = oldResults;
            historyEntry.resultCount = oldResults.length;
            historyEntry.timestamp = Date.now();
            this.saveHistory();
            // Update in-memory state
            this._lastResults = oldResults;
            this._lastQuery = historyEntry.query;
            this.log(`Auto-refresh: +${newCount} novos resultados para "${historyEntry.query}"`);
            BdApi.UI.showToast(`Auto-refresh: +${newCount} novo(s) resultado(s) para "${historyEntry.query}"`, { type: "info" });
        } else {
            historyEntry.timestamp = Date.now();
            this.saveHistory();
            this.log(`Auto-refresh: nenhum resultado novo para "${historyEntry.query}"`);
        }
    }

    // ========== GUILD FOLDERS ==========

    getGuildFolders() {
        // Try to get folder structure from SortedGuildStore
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
        this.log(`Encontradas ${folders.length} pastas de servidores`);
        return folders;
    }

    // ========== QUERY VARIANTS ==========

    // Generate search query variants to catch different spellings
    _generateQueryVariants(query) {
        const variants = new Set([query]);
        const words = query.split(/\s+/);

        for (let wi = 0; wi < words.length; wi++) {
            const word = words[wi].toLowerCase();
            if (word.length < 4) continue; // Skip short words

            // Variant 1: remove double letters (cannelloni -> caneloni)
            const singleLetters = word.replace(/(.)\1+/g, "$1");
            if (singleLetters !== word) {
                const v = [...words];
                v[wi] = singleLetters;
                variants.add(v.join(" "));
            }

            // Variant 2: double each single consonant that could be doubled
            // (caneloni -> canneloni, canelloni, canelonni)
            // Only do the most likely one — double the first consonant cluster
            const doubled = word.replace(/([bcdfgklmnprst])(?!\1)/i, "$1$1");
            if (doubled !== word) {
                const v = [...words];
                v[wi] = doubled;
                variants.add(v.join(" "));
            }
        }

        // Limit to 3 variants max to avoid too many API calls
        return [...variants].slice(0, 3);
    }

    // ========== FUZZY MATCHING ==========

    // Levenshtein distance — how many edits to transform a into b
    _levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = a[i - 1] === b[j - 1]
                    ? dp[i - 1][j - 1]
                    : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
        return dp[m][n];
    }

    // Check if query words fuzzy-match the message content
    // Each query word must match at least one word in the message (exact or fuzzy)
    _fuzzyMatch(content, query) {
        const contentLower = content.toLowerCase();
        const queryLower = query.toLowerCase();

        // Exact substring match — always passes
        if (contentLower.includes(queryLower)) return true;

        // Split into words and check each query word
        const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);
        const contentWords = contentLower.split(/\s+/).filter(w => w.length > 0);

        return queryWords.every(qw => {
            // Exact word match
            if (contentWords.some(cw => cw.includes(qw))) return true;

            // Fuzzy match — allow ~30% edit distance (typo tolerance)
            const maxDist = Math.max(1, Math.floor(qw.length * 0.35));
            return contentWords.some(cw => {
                // Only compare words of similar length to avoid false positives
                if (Math.abs(cw.length - qw.length) > maxDist) return false;
                return this._levenshtein(qw, cw) <= maxDist;
            });
        });
    }

    // Filter results: apply exclude words
    _filterResults(results, excludeWords) {
        return results.filter(msg => {
            const content = msg.content.toLowerCase();

            // Exclude messages containing excluded words
            if (excludeWords && excludeWords.length > 0) {
                for (const word of excludeWords) {
                    if (word && content.includes(word.toLowerCase())) {
                        return false;
                    }
                }
            }

            // Discord API already matched the query — keep all non-excluded
            return true;
        });
    }

    // ========== NAVIGATION ==========

    goToMessage(guildId, channelId, messageId) {
        const path = `/channels/${guildId}/${channelId}/${messageId}`;
        this.log(`Navegando para: ${path}`);

        // Method 1: transitionTo with message ID in path (no reload)
        if (this.modules.NavigationUtils?.transitionTo) {
            try {
                this.modules.NavigationUtils.transitionTo(path);
                this.log("Navegou via NavigationUtils.transitionTo");
                return;
            } catch (e) {
                this.log(`Erro NavigationUtils: ${e.message}`);
            }
        }

        // Method 2: Find transitionTo via webpack at runtime
        try {
            const navModule = BdApi.Webpack.getByKeys("transitionTo");
            if (navModule?.transitionTo) {
                navModule.transitionTo(path);
                this.log("Navegou via webpack transitionTo");
                return;
            }
        } catch (e) {
            this.log(`Erro webpack nav: ${e.message}`);
        }

        // Method 3: RouterStore history push
        try {
            const RouterStore = BdApi.Webpack.getStore("RouterStore");
            if (RouterStore) {
                const history = RouterStore.getHistory?.() || RouterStore.__getLocalVars?.()?.history;
                if (history?.push) {
                    history.push(path);
                    this.log("Navegou via RouterStore history");
                    return;
                }
            }
        } catch (e) {
            this.log(`Erro RouterStore: ${e.message}`);
        }

        // Method 4: Use history.pushState + dispatch popstate (SPA navigation, no reload)
        try {
            window.history.pushState(null, "", path);
            window.dispatchEvent(new PopStateEvent("popstate"));
            this.log("Navegou via history.pushState + popstate");
            return;
        } catch (e) {
            this.log(`Erro pushState: ${e.message}`);
        }

        // Method 5: Last resort — open in same tab but warn
        this.log("AVISO: Nenhum metodo de navegacao SPA funcionou, nao redirecionando");
        BdApi.UI.showToast("Nao foi possivel navegar ate a mensagem. Tente atualizar o Discord.", { type: "error" });
    }

    // ========== DM & FORWARD ==========

    async openDMWithUser(authorId) {
        try {
            const resp = await this.discordPost("https://discord.com/api/v9/users/@me/channels", {
                recipient_id: authorId
            });
            if (!resp.ok) {
                this.log(`ERRO ao abrir DM: status ${resp.status}`);
                BdApi.UI.showToast("Erro ao abrir DM com este usuario.", { type: "error" });
                return null;
            }
            const dmChannel = await resp.json();
            this.log(`DM channel aberto: ${dmChannel.id} com usuario ${authorId}`);

            // Method 1: selectPrivateChannel
            if (this.modules.ChannelActions?.selectPrivateChannel) {
                try {
                    this.modules.ChannelActions.selectPrivateChannel(dmChannel.id);
                    this.log("Navegou para DM via selectPrivateChannel");
                    return dmChannel;
                } catch (e) {
                    this.log(`Erro selectPrivateChannel: ${e.message}`);
                }
            }

            // Method 2: NavigationUtils.transitionTo
            if (this.modules.NavigationUtils?.transitionTo) {
                try {
                    this.modules.NavigationUtils.transitionTo(`/channels/@me/${dmChannel.id}`);
                    this.log("Navegou para DM via transitionTo");
                    return dmChannel;
                } catch (e) {
                    this.log(`Erro transitionTo DM: ${e.message}`);
                }
            }

            // Method 3: history.pushState fallback
            try {
                window.history.pushState(null, "", `/channels/@me/${dmChannel.id}`);
                window.dispatchEvent(new PopStateEvent("popstate"));
                this.log("Navegou para DM via pushState");
                return dmChannel;
            } catch (e) {
                this.log(`Erro pushState DM: ${e.message}`);
            }

            BdApi.UI.showToast("Nao foi possivel abrir a DM.", { type: "error" });
            return dmChannel;
        } catch (err) {
            this.log(`ERRO openDMWithUser: ${err.message}`);
            BdApi.UI.showToast("Erro ao abrir DM.", { type: "error" });
            return null;
        }
    }

    async forwardMessageToDM(dmChannelId, msg) {
        try {
            const date = new Date(msg.timestamp);
            const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

            const messageLink = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;

            const lines = [
                `> **${msg.author}** em **${msg.guildName}** > #${msg.channelName}`,
                `> ${dateStr}`,
                `> `,
                ...msg.content.split("\n").map(line => `> ${line}`),
                ``,
                `[Ir para a mensagem original](${messageLink})`
            ];

            let content = lines.join("\n");

            // Truncate if over Discord's 2000 char limit
            if (content.length > 2000) {
                const header = lines.slice(0, 4).join("\n");
                const footer = `\n\n[Ir para a mensagem original](${messageLink})`;
                const maxContent = 2000 - header.length - footer.length - 20;
                const truncated = msg.content.substring(0, maxContent) + "...";
                content = header + "\n" + truncated.split("\n").map(line => `> ${line}`).join("\n") + footer;
            }

            const resp = await this.discordPost(`https://discord.com/api/v9/channels/${dmChannelId}/messages`, {
                content: content
            });

            if (resp.ok) {
                this.log(`Mensagem encaminhada para DM ${dmChannelId}`);
                BdApi.UI.showToast("Mensagem encaminhada!", { type: "success" });
            } else {
                const errData = await resp.json().catch(() => ({}));
                this.log(`ERRO ao encaminhar: ${resp.status} - ${JSON.stringify(errData)}`);
                if (resp.status === 403) {
                    BdApi.UI.showToast("Nao foi possivel enviar. O usuario pode ter DMs desabilitadas.", { type: "error" });
                } else if (resp.status === 429) {
                    const retryAfter = errData.retry_after || 5;
                    BdApi.UI.showToast(`Rate limited. Tente em ${Math.ceil(retryAfter)}s.`, { type: "warning" });
                } else {
                    BdApi.UI.showToast("Erro ao encaminhar a mensagem.", { type: "error" });
                }
            }
        } catch (err) {
            this.log(`ERRO forwardMessageToDM: ${err.message}`);
            BdApi.UI.showToast("Erro ao encaminhar a mensagem.", { type: "error" });
        }
    }

    insertTextInChatBox(msg) {
        const date = new Date(msg.timestamp);
        const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        const messageLink = `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`;

        const lines = [
            `> **${msg.author}** em **${msg.guildName}** > #${msg.channelName}`,
            `> ${dateStr}`,
            `> `,
            ...msg.content.split("\n").map(line => `> ${line}`),
            ``,
            messageLink
        ];
        let text = lines.join("\n");
        if (text.length > 2000) {
            const header = lines.slice(0, 3).join("\n");
            const footer = `\n\n${messageLink}`;
            const maxContent = 2000 - header.length - footer.length - 20;
            text = header + "\n> " + msg.content.substring(0, maxContent) + "..." + footer;
        }

        try {
            // Method 1: ComponentDispatch (Discord's internal event system)
            const ComponentDispatch = BdApi.Webpack.getModule(m => m?.dispatchToLastSubscribed && m?.emitter, { searchExports: false })
                || BdApi.Webpack.getByKeys("dispatchToLastSubscribed");
            if (ComponentDispatch?.dispatchToLastSubscribed) {
                ComponentDispatch.dispatchToLastSubscribed("INSERT_TEXT", { rawText: text, plainText: text });
                this.log("Texto inserido via ComponentDispatch");
                BdApi.UI.showToast("Mensagem preparada! Edite e aperte Enter.", { type: "success" });
                return;
            }

            // Method 2: Find the textarea and set its value via React fiber
            const textarea = document.querySelector('[class*="slateTextArea-"] [data-slate-editor="true"]')
                || document.querySelector('[role="textbox"][contenteditable="true"]');
            if (textarea) {
                textarea.focus();
                document.execCommand("insertText", false, text);
                this.log("Texto inserido via execCommand");
                BdApi.UI.showToast("Mensagem preparada! Edite e aperte Enter.", { type: "success" });
                return;
            }

            this.log("AVISO: Nao encontrou caixa de texto");
            BdApi.UI.showToast("Nao foi possivel inserir o texto. Cole manualmente.", { type: "warning" });
        } catch (err) {
            this.log(`ERRO insertTextInChatBox: ${err.message}`);
            BdApi.UI.showToast("Erro ao inserir texto.", { type: "error" });
        }
    }

    // ========== KEYBIND ==========

    setupKeybind() {
        this._keyHandler = (e) => {
            // Ctrl+Shift+F to open global search
            if (e.ctrlKey && e.shiftKey && e.key === "F") {
                e.preventDefault();
                e.stopPropagation();
                // Don't open if already open
                if (!document.querySelector(".gs-modal-overlay")) {
                    this.openSearchModal();
                }
            }
        };
        document.addEventListener("keydown", this._keyHandler, true);
    }

    removeKeybind() {
        if (this._keyHandler) {
            document.removeEventListener("keydown", this._keyHandler, true);
            this._keyHandler = null;
        }
    }

    // ========== UI: TOOLBAR BUTTON ==========

    setupObserver() {
        this.observer = new MutationObserver(() => {
            if (!document.getElementById(this.buttonId)) {
                this.injectButton();
            }
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    injectButton() {
        if (document.getElementById(this.buttonId)) return;
        const toolbar = document.querySelector('[class*="toolbar_"]') || document.querySelector('[class*="toolbar-"]') || document.querySelector('[class*="Toolbar"]');
        if (!toolbar) return;

        const btn = document.createElement("div");
        btn.id = this.buttonId;
        btn.className = "global-search-toolbar-btn";
        btn.title = "Busca Global";
        btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            <path d="M12 10h-2v2H9v-2H7V9h2V7h1v2h2v1z"/>
        </svg>`;
        btn.addEventListener("click", () => this.openSearchModal());

        toolbar.insertBefore(btn, toolbar.firstChild);
    }

    removeButton() {
        const btn = document.getElementById(this.buttonId);
        if (btn) btn.remove();
    }

    // ========== UI: SEARCH MODAL ==========

    openSearchModal() {
        const guilds = this.modules.GuildStore.getGuilds();
        const guildList = Object.values(guilds).sort((a, b) => a.name.localeCompare(b.name));

        // Create modal overlay
        const overlay = document.createElement("div");
        overlay.className = "gs-modal-overlay";
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.remove();
        });

        const modal = document.createElement("div");
        modal.className = "gs-modal";

        // Header
        const header = document.createElement("div");
        header.className = "gs-modal-header";
        header.innerHTML = `
            <h2>Busca Global</h2>
            <div class="gs-close" id="gs-close-btn">&times;</div>
        `;

        // Search input area
        const searchArea = document.createElement("div");
        searchArea.className = "gs-search-area";

        const searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.className = "gs-search-input";
        searchInput.placeholder = "Digite sua busca... (ex: dragon canneloni)";
        searchInput.autofocus = true;

        const searchBtn = document.createElement("button");
        searchBtn.className = "gs-search-btn";
        searchBtn.textContent = "Buscar";

        // Refresh button (incremental update)
        const refreshBtn = document.createElement("button");
        refreshBtn.className = "gs-refresh-btn";
        refreshBtn.textContent = "Atualizar";
        refreshBtn.title = "Busca apenas mensagens novas desde a ultima pesquisa deste termo";

        searchArea.append(searchInput, searchBtn, refreshBtn);

        // Search history dropdown
        const historyWrapper = document.createElement("div");
        historyWrapper.className = "gs-history-wrapper";

        const historyDropdown = document.createElement("div");
        historyDropdown.className = "gs-history-dropdown";
        historyDropdown.style.display = "none";

        // Helper to restore a history/archived entry into the modal
        const restoreEntry = (entry) => {
            searchInput.value = entry.query;
            if (entry.variants && entry.variants.length > 0) {
                fuzzyInput.value = entry.variants.join(", ");
            }
            if (entry.excludeWords && entry.excludeWords.length > 0) {
                excludeInput.value = entry.excludeWords.join(", ");
            }
            historyDropdown.style.display = "none";
            // Restore channel filter state from history entry
            this._activeChannelFilter = entry.channelFilter || null;
            this._excludedChannels = new Set(entry.excludedChannels || []);
            if (entry.results && entry.results.length > 0) {
                this._lastResults = entry.results;
                this._lastQuery = entry.query;
                progressArea.style.display = "block";
                const date = new Date(entry.timestamp);
                const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
                progressArea.innerHTML = `<span>Historico: "${this.escapeHtml(entry.query)}" — ${entry.resultCount} resultado(s) de ${dateStr}</span>`;
                this.renderResults(resultsArea, entry.results, overlay);
            }
            if (entry.guildIds) {
                guildCheckboxes.forEach(cb => { cb.checked = false; });
                for (const id of entry.guildIds) {
                    if (guildIdToCheckbox[id]) guildIdToCheckbox[id].checked = true;
                }
                updateCount();
            }
        };

        const buildHistoryDropdown = () => {
            historyDropdown.innerHTML = "";
            const hasHistory = this._searchHistory.length > 0;
            const hasArchived = this._archivedSearches.length > 0;

            if (!hasHistory && !hasArchived) {
                historyDropdown.innerHTML = `<div class="gs-history-empty">Nenhuma pesquisa anterior</div>`;
                return;
            }

            // Archived section (shown first if there are archives)
            if (hasArchived) {
                const archHeader = document.createElement("div");
                archHeader.className = "gs-history-header gs-archive-header";
                archHeader.innerHTML = `<span>\u2605 Arquivados (${this._archivedSearches.length})</span>`;
                historyDropdown.appendChild(archHeader);

                for (const entry of this._archivedSearches) {
                    const item = document.createElement("div");
                    item.className = "gs-history-item gs-archived-item";
                    const date = new Date(entry.archivedAt || entry.timestamp);
                    const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
                    item.innerHTML = `
                        <span class="gs-history-query">\u2605 ${this.escapeHtml(entry.query)}</span>
                        <span class="gs-history-meta">${entry.resultCount} result. | ${dateStr}</span>
                    `;
                    item.addEventListener("click", () => restoreEntry(entry));

                    // Action buttons container
                    const actions = document.createElement("div");
                    actions.className = "gs-history-actions";

                    // Unarchive button
                    const unarchBtn = document.createElement("button");
                    unarchBtn.className = "gs-history-archive gs-history-archive-active";
                    unarchBtn.innerHTML = "\u2605";
                    unarchBtn.title = "Remover dos arquivos";
                    unarchBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        this.unarchiveSearch(entry.query);
                        buildHistoryDropdown();
                        BdApi.UI.showToast(`"${entry.query}" removido dos arquivos.`, { type: "info" });
                    });
                    actions.appendChild(unarchBtn);
                    item.appendChild(actions);
                    historyDropdown.appendChild(item);
                }
            }

            if (!hasHistory) return;

            // History header with clear button and storage size
            const storageInfo = this.getStorageSize();
            const histHeader = document.createElement("div");
            histHeader.className = "gs-history-header";
            histHeader.innerHTML = `<span>Historico de buscas <span class="gs-storage-size" title="Historico: ${storageInfo.history} | Arquivados: ${storageInfo.archived}">(${storageInfo.total})</span></span>`;
            const clearBtn = document.createElement("button");
            clearBtn.className = "gs-history-clear";
            clearBtn.textContent = "Limpar";
            clearBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.clearHistory();
                buildHistoryDropdown();
                BdApi.UI.showToast("Historico limpo!", { type: "info" });
            });
            histHeader.appendChild(clearBtn);
            historyDropdown.appendChild(histHeader);

            for (const entry of this._searchHistory.slice(0, 15)) {
                const item = document.createElement("div");
                item.className = "gs-history-item";
                const date = new Date(entry.timestamp);
                const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
                item.innerHTML = `
                    <span class="gs-history-query">${this.escapeHtml(entry.query)}</span>
                    <span class="gs-history-meta">${entry.resultCount} result. | ${dateStr}</span>
                `;
                item.addEventListener("click", () => restoreEntry(entry));

                // Action buttons container
                const actions = document.createElement("div");
                actions.className = "gs-history-actions";

                // Archive button (star toggle)
                const archiveBtn = document.createElement("button");
                const isArchived = this._archivedSearches.some(a => a.query === entry.query);
                archiveBtn.className = "gs-history-archive" + (isArchived ? " gs-history-archive-active" : "");
                archiveBtn.innerHTML = isArchived ? "\u2605" : "\u2606";
                archiveBtn.title = isArchived ? "Ja arquivado" : "Arquivar busca";
                archiveBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (isArchived) {
                        this.unarchiveSearch(entry.query);
                        BdApi.UI.showToast(`"${entry.query}" removido dos arquivos.`, { type: "info" });
                    } else {
                        this.archiveSearch(entry);
                        BdApi.UI.showToast(`"${entry.query}" arquivado!`, { type: "success" });
                    }
                    buildHistoryDropdown();
                });
                actions.appendChild(archiveBtn);

                // Delete button
                const deleteBtn = document.createElement("button");
                deleteBtn.className = "gs-history-delete";
                deleteBtn.innerHTML = "&times;";
                deleteBtn.title = "Remover do historico";
                deleteBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.deleteHistoryEntry(entry.query);
                    buildHistoryDropdown();
                    BdApi.UI.showToast(`"${entry.query}" removido do historico.`, { type: "info" });
                });
                actions.appendChild(deleteBtn);

                item.appendChild(actions);
                historyDropdown.appendChild(item);
            }
        };

        // Show/hide history on focus/blur
        searchInput.addEventListener("focus", () => {
            buildHistoryDropdown();
            if (this._searchHistory.length > 0 || this._archivedSearches.length > 0) {
                historyDropdown.style.display = "block";
            }
        });
        searchInput.addEventListener("input", () => {
            const val = searchInput.value.toLowerCase();
            if (!val) {
                buildHistoryDropdown();
                historyDropdown.style.display = (this._searchHistory.length > 0 || this._archivedSearches.length > 0) ? "block" : "none";
                return;
            }
            // Filter history items
            buildHistoryDropdown();
            const items = historyDropdown.querySelectorAll(".gs-history-item");
            let visible = 0;
            items.forEach(item => {
                const q = item.querySelector(".gs-history-query")?.textContent?.toLowerCase() || "";
                const match = q.includes(val);
                item.style.display = match ? "" : "none";
                if (match) visible++;
            });
            historyDropdown.style.display = visible > 0 ? "block" : "none";
        });
        // Hide dropdown when clicking elsewhere
        overlay.addEventListener("click", (e) => {
            if (!historyWrapper.contains(e.target) && e.target !== searchInput) {
                historyDropdown.style.display = "none";
            }
        });

        historyWrapper.append(historyDropdown);

        // Period selector
        const periodArea = document.createElement("div");
        periodArea.className = "gs-period-area";

        const periodLabel = document.createElement("span");
        periodLabel.className = "gs-period-label";
        periodLabel.textContent = "Periodo:";

        const periodSelect = document.createElement("select");
        periodSelect.className = "gs-period-select";
        const periods = [
            { value: "10m", label: "Ultimos 10 minutos" },
            { value: "30m", label: "Ultimos 30 minutos" },
            { value: "1h", label: "Ultima 1 hora" },
            { value: "3h", label: "Ultimas 3 horas" },
            { value: "6h", label: "Ultimas 6 horas" },
            { value: "12h", label: "Ultimas 12 horas" },
            { value: "24h", label: "Ultimas 24 horas" },
            { value: "48h", label: "Ultimas 48 horas" },
            { value: "7d", label: "Ultimos 7 dias" },
            { value: "30d", label: "Ultimos 30 dias" },
            { value: "90d", label: "Ultimos 90 dias" },
            { value: "365d", label: "Ultimo ano" },
            { value: "all", label: "Todos (sem limite)" }
        ];
        for (const p of periods) {
            const opt = document.createElement("option");
            opt.value = p.value;
            opt.textContent = p.label;
            if (p.value === "12h") opt.selected = true;
            periodSelect.appendChild(opt);
        }

        // Auto-refresh toggle
        const autoRefreshLabel = document.createElement("label");
        autoRefreshLabel.className = "gs-auto-refresh-toggle";
        const autoRefreshCb = document.createElement("input");
        autoRefreshCb.type = "checkbox";
        autoRefreshCb.checked = this.settings.autoRefresh;
        autoRefreshCb.addEventListener("change", () => {
            this.settings.autoRefresh = autoRefreshCb.checked;
            this.saveSettings();
        });
        const autoRefreshText = document.createElement("span");
        autoRefreshText.textContent = "Auto-refresh";
        autoRefreshText.title = "Atualiza automaticamente quando o Discord perde foco (alt-tab)";
        autoRefreshLabel.append(autoRefreshCb, autoRefreshText);

        periodArea.append(periodLabel, periodSelect, autoRefreshLabel);

        // Fuzzy / custom variants area
        const fuzzyArea = document.createElement("div");
        fuzzyArea.className = "gs-fuzzy-area";

        const fuzzyLabel = document.createElement("span");
        fuzzyLabel.className = "gs-period-label";
        fuzzyLabel.textContent = "Tambem buscar:";

        const fuzzyInput = document.createElement("input");
        fuzzyInput.type = "text";
        fuzzyInput.className = "gs-fuzzy-input";
        fuzzyInput.placeholder = "variantes separadas por virgula (ex: cannelloni, caneloni, canelloni)";
        fuzzyInput.value = (this.settings.fuzzyTerms || []).join(", ");

        const fuzzyHelp = document.createElement("span");
        fuzzyHelp.className = "gs-exclude-help";
        fuzzyHelp.textContent = "Cada variante sera buscada como termo separado nos servidores";

        fuzzyArea.append(fuzzyLabel, fuzzyInput, fuzzyHelp);

        // Exclude words filter
        const excludeArea = document.createElement("div");
        excludeArea.className = "gs-exclude-area";

        const excludeLabel = document.createElement("span");
        excludeLabel.className = "gs-period-label";
        excludeLabel.textContent = "Excluir palavras:";

        const excludeInput = document.createElement("input");
        excludeInput.type = "text";
        excludeInput.className = "gs-exclude-input";
        excludeInput.placeholder = "ex: buy, sell, trade (separadas por virgula)";
        excludeInput.value = (this.settings.excludeWords || []).join(", ");

        const excludeHelp = document.createElement("span");
        excludeHelp.className = "gs-exclude-help";
        excludeHelp.textContent = "Mensagens com essas palavras serao removidas dos resultados";

        excludeArea.append(excludeLabel, excludeInput, excludeHelp);

        // Guild selector
        const guildSection = document.createElement("div");
        guildSection.className = "gs-guild-section";

        // --- Folder quick-select buttons ---
        const folders = this.getGuildFolders();
        const folderArea = document.createElement("div");
        folderArea.className = "gs-folder-area";

        const guildCheckboxes = [];
        const guildLabels = [];
        const guildIdToCheckbox = {};

        // Helper to update checkboxes by guild IDs
        const setGuildsChecked = (guildIds, checked) => {
            for (const id of guildIds) {
                if (guildIdToCheckbox[id]) guildIdToCheckbox[id].checked = checked;
            }
        };

        // "Todos" button
        const allBtn = document.createElement("button");
        allBtn.className = "gs-folder-btn";
        allBtn.textContent = `Todos (${guildList.length})`;
        allBtn.addEventListener("click", () => {
            guildCheckboxes.forEach(cb => { cb.checked = true; });
            updateCount();
        });
        folderArea.appendChild(allBtn);

        // "Nenhum" button
        const noneBtn = document.createElement("button");
        noneBtn.className = "gs-folder-btn";
        noneBtn.textContent = "Nenhum";
        noneBtn.addEventListener("click", () => {
            guildCheckboxes.forEach(cb => { cb.checked = false; });
            updateCount();
        });
        folderArea.appendChild(noneBtn);

        // Folder buttons (toggle mode — click to add, click again to remove)
        for (const folder of folders) {
            const btn = document.createElement("button");
            btn.className = "gs-folder-btn";
            const colorHex = folder.color ? `#${folder.color.toString(16).padStart(6, "0")}` : null;
            if (colorHex) {
                btn.style.borderLeft = `3px solid ${colorHex}`;
            }
            btn.textContent = `${folder.name} (${folder.guildIds.length})`;
            btn.title = `Toggle: selecionar/desmarcar esta pasta`;
            let folderActive = false;
            btn.addEventListener("click", () => {
                folderActive = !folderActive;
                // Toggle: if activating, check this folder's guilds; if deactivating, uncheck them
                setGuildsChecked(folder.guildIds, folderActive);
                btn.classList.toggle("gs-folder-btn-active", folderActive);
                updateCount();
            });
            folderArea.appendChild(btn);
        }

        // --- Header row ---
        const guildHeader = document.createElement("div");
        guildHeader.className = "gs-guild-header";

        const guildCountSpan = document.createElement("span");
        guildCountSpan.className = "gs-guild-count";
        guildCountSpan.textContent = `0/${guildList.length} selecionados`;

        const toggleBtn = document.createElement("button");
        toggleBtn.className = "gs-toggle-guilds";
        toggleBtn.textContent = "Mostrar servidores";
        let guildsVisible = false;

        guildHeader.append(guildCountSpan, toggleBtn);

        // --- Filter input ---
        const guildFilterInput = document.createElement("input");
        guildFilterInput.type = "text";
        guildFilterInput.className = "gs-guild-filter";
        guildFilterInput.placeholder = "Filtrar servidores...";
        guildFilterInput.style.display = "none";

        // --- Guild list ---
        const guildListDiv = document.createElement("div");
        guildListDiv.className = "gs-guild-list";
        guildListDiv.style.display = "none";

        for (const guild of guildList) {
            const label = document.createElement("label");
            label.className = "gs-checkbox-label gs-guild-item";
            label.dataset.name = guild.name.toLowerCase();
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = false;
            cb.dataset.guildId = guild.id;
            cb.addEventListener("change", updateCount);
            guildCheckboxes.push(cb);
            guildLabels.push(label);
            guildIdToCheckbox[guild.id] = cb;

            const icon = document.createElement("img");
            icon.className = "gs-guild-icon";
            icon.src = guild.icon
                ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=20`
                : "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0iIzcyNzY3ZCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHJ4PSI0IiBmaWxsPSIjMzYzOTNmIi8+PHRleHQgeD0iMTAiIHk9IjE0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjZGNkZGRlIj4/PC90ZXh0Pjwvc3ZnPg==";
            icon.onerror = () => { icon.style.display = "none"; };

            label.append(cb, icon, document.createTextNode(` ${guild.name}`));
            guildListDiv.appendChild(label);
        }

        function updateCount() {
            const count = guildCheckboxes.filter(cb => cb.checked).length;
            guildCountSpan.textContent = `${count}/${guildList.length} selecionados`;
        }

        // Filter guilds as user types
        guildFilterInput.addEventListener("input", () => {
            const filter = guildFilterInput.value.toLowerCase();
            for (const label of guildLabels) {
                const match = !filter || label.dataset.name.includes(filter);
                label.style.display = match ? "" : "none";
            }
        });

        toggleBtn.addEventListener("click", () => {
            guildsVisible = !guildsVisible;
            guildFilterInput.style.display = guildsVisible ? "block" : "none";
            guildListDiv.style.display = guildsVisible ? "grid" : "none";
            toggleBtn.textContent = guildsVisible ? "Ocultar servidores" : "Mostrar servidores";
            if (guildsVisible) guildFilterInput.focus();
        });

        guildSection.append(folderArea, guildHeader, guildFilterInput, guildListDiv);

        // Progress area
        const progressArea = document.createElement("div");
        progressArea.className = "gs-progress";
        progressArea.style.display = "none";

        // Results area
        const resultsArea = document.createElement("div");
        resultsArea.className = "gs-results";

        // Assemble modal
        modal.append(header, searchArea, historyWrapper, periodArea, fuzzyArea, excludeArea, guildSection, progressArea, resultsArea);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Close button — just closes modal, does NOT cancel background search
        const closeModal = () => {
            overlay.remove();
        };
        header.querySelector("#gs-close-btn").addEventListener("click", closeModal);

        // ESC to close
        const escHandler = (e) => {
            if (e.key === "Escape") {
                closeModal();
                document.removeEventListener("keydown", escHandler);
            }
        };
        document.addEventListener("keydown", escHandler);

        // Restore previous results if they exist
        if (this._lastQuery) {
            searchInput.value = this._lastQuery;
        }
        if (this._isSearching) {
            searchBtn.disabled = true;
            searchBtn.textContent = "Buscando...";
            this._updateModalProgress();
            // Show partial results found so far
            if (this._lastResults && this._lastResults.length > 0) {
                this.renderResults(resultsArea, this._lastResults, overlay);
            }
        } else if (this._lastResults && this._lastResults.length > 0) {
            progressArea.style.display = "block";
            progressArea.innerHTML = `<span>Ultima busca: "${this.escapeHtml(this._lastQuery)}" — ${this._lastResults.length} resultado(s).</span>`;
            this.renderResults(resultsArea, this._lastResults, overlay);
        }

        // Search action
        const doSearch = () => {
            const query = searchInput.value.trim();
            if (!query) return;

            if (this._isSearching) {
                BdApi.UI.showToast("Busca ja em andamento! Aguarde.", { type: "warning" });
                return;
            }

            const selectedGuildIds = guildCheckboxes
                .filter(cb => cb.checked)
                .map(cb => cb.dataset.guildId);

            if (selectedGuildIds.length === 0) {
                BdApi.UI.showToast("Selecione pelo menos um servidor!", { type: "warning" });
                return;
            }

            searchBtn.disabled = true;
            searchBtn.textContent = "Buscando...";
            progressArea.style.display = "block";
            resultsArea.innerHTML = "";

            // Parse period to min_id (Discord Snowflake)
            const period = periodSelect.value;
            let minSnowflake = null;
            if (period !== "all") {
                const now = Date.now();
                let ms;
                if (period.endsWith("m")) ms = parseInt(period) * 60000;
                else if (period.endsWith("h")) ms = parseInt(period) * 3600000;
                else ms = parseInt(period) * 86400000;
                const cutoff = now - ms;
                // Discord Snowflake = (timestamp - DISCORD_EPOCH) << 22
                const DISCORD_EPOCH = 1420070400000;
                minSnowflake = String(BigInt(cutoff - DISCORD_EPOCH) << 22n);
            }

            // Parse exclude words
            const excludeWords = excludeInput.value
                .split(",")
                .map(w => w.trim().toLowerCase())
                .filter(w => w.length > 0);
            // Parse fuzzy / custom variant terms
            const fuzzyTerms = fuzzyInput.value
                .split(",")
                .map(w => w.trim())
                .filter(w => w.length > 0);
            // Save settings
            this.settings.excludeWords = excludeWords;
            this.settings.fuzzyTerms = fuzzyTerms;
            this.saveSettings();

            // Reset channel filters for new search
            this._activeChannelFilter = null;
            this._excludedChannels = new Set();
            // Start search in background (not awaited — runs independently)
            this.searchMultipleGuilds(selectedGuildIds, query, minSnowflake, excludeWords, fuzzyTerms);
        };

        searchBtn.addEventListener("click", doSearch);
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                historyDropdown.style.display = "none";
                doSearch();
            }
        });

        // Refresh button — incremental search from last history timestamp
        refreshBtn.addEventListener("click", () => {
            const query = searchInput.value.trim();
            if (!query) return;
            const histEntry = this.getHistoryEntry(query);
            if (!histEntry) {
                BdApi.UI.showToast("Nenhuma busca anterior para esse termo. Use 'Buscar' primeiro.", { type: "warning" });
                return;
            }
            if (this._isSearching) {
                BdApi.UI.showToast("Busca ja em andamento!", { type: "warning" });
                return;
            }

            refreshBtn.disabled = true;
            refreshBtn.textContent = "Atualizando...";
            progressArea.style.display = "block";
            const totalGuilds = (histEntry.guildIds || []).length;
            progressArea.innerHTML = `<span>Atualizando 0/${totalGuilds} servidores... (+0 novos)</span><div class="gs-progress-bar-bg"><div class="gs-progress-bar" style="width:0%"></div></div>`;

            const onProgress = (done, total, newCount) => {
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                progressArea.innerHTML = `<span>Atualizando ${done}/${total} servidores... (+${newCount} novos)</span><div class="gs-progress-bar-bg"><div class="gs-progress-bar" style="width:${pct}%"></div></div>`;
            };

            this._runAutoRefresh(histEntry, onProgress).then(() => {
                refreshBtn.disabled = false;
                refreshBtn.textContent = "Atualizar";
                if (this._lastResults) {
                    this.renderResults(resultsArea, this._lastResults, overlay);
                    progressArea.innerHTML = `<span>Atualizado! ${this._lastResults.length} resultado(s) total.</span>`;
                }
            });
        });

        // Restore paused search state if exists
        if (this._isPaused && this._pausedState) {
            searchInput.value = this._pausedState.query;
            if (this._pausedState.customVariants && this._pausedState.customVariants.length > 0) {
                fuzzyInput.value = this._pausedState.customVariants.join(", ");
            }
            if (this._pausedState.excludeWords && this._pausedState.excludeWords.length > 0) {
                excludeInput.value = this._pausedState.excludeWords.join(", ");
            }
            this._lastResults = this._pausedState.partialResults;
            this._lastQuery = this._pausedState.query;
            if (this._pausedState.guildIds) {
                guildCheckboxes.forEach(cb => { cb.checked = false; });
                for (const id of this._pausedState.guildIds) {
                    if (guildIdToCheckbox[id]) guildIdToCheckbox[id].checked = true;
                }
                updateCount();
            }
            progressArea.style.display = "block";
            this._updateModalPaused();
            if (this._lastResults && this._lastResults.length > 0) {
                this.renderResults(resultsArea, this._lastResults, overlay);
            }
        }

        // Focus input
        setTimeout(() => searchInput.focus(), 100);
    }

    renderResults(container, results, overlay) {
        container.innerHTML = "";

        if (results.length === 0) {
            container.innerHTML = `<div class="gs-no-results">Nenhuma mensagem encontrada.</div>`;
            return;
        }

        // View mode selector
        const viewBar = document.createElement("div");
        viewBar.className = "gs-view-bar";

        const viewLabel = document.createElement("span");
        viewLabel.className = "gs-view-label";
        viewLabel.textContent = "Visualizacao:";

        const modes = [
            { key: "compact", label: "Compacta" },
            { key: "traditional", label: "Tradicional" },
            { key: "detailed", label: "Detalhada" }
        ];

        const viewBtns = [];
        for (const mode of modes) {
            const btn = document.createElement("button");
            btn.className = "gs-view-btn" + (this.settings.viewMode === mode.key ? " gs-view-btn-active" : "");
            btn.textContent = mode.label;
            btn.dataset.mode = mode.key;
            btn.addEventListener("click", () => {
                this.settings.viewMode = mode.key;
                this.saveSettings();
                viewBtns.forEach(b => b.classList.toggle("gs-view-btn-active", b.dataset.mode === mode.key));
                this._renderResultItems(resultsList, results, overlay);
            });
            viewBtns.push(btn);
            viewBar.appendChild(btn);
        }

        // Separator before find button
        const separator = document.createElement("span");
        separator.className = "gs-view-separator";
        separator.textContent = "|";
        viewBar.appendChild(separator);

        // Find in results button
        const findBtn = document.createElement("button");
        findBtn.className = "gs-view-btn gs-find-toggle-btn";
        findBtn.textContent = "\uD83D\uDD0D Buscar";
        findBtn.title = "Buscar nos resultados";
        viewBar.appendChild(findBtn);

        // Channel filter dropdown
        const channelMap = new Map();
        for (const msg of results) {
            const key = `${msg.guildId}:${msg.channelId}`;
            if (!channelMap.has(key)) {
                channelMap.set(key, { guildName: msg.guildName, channelName: msg.channelName, channelId: msg.channelId, guildId: msg.guildId, count: 0 });
            }
            channelMap.get(key).count++;
        }

        const channelFilterBtn = document.createElement("button");
        channelFilterBtn.className = "gs-view-btn gs-channel-filter-btn";
        channelFilterBtn.title = "Filtrar por canal";
        viewBar.appendChild(channelFilterBtn);

        // Restore button label from persisted state
        if (this._activeChannelFilter) {
            const chInfo = channelMap.get(this._activeChannelFilter);
            channelFilterBtn.textContent = chInfo ? `#${chInfo.channelName}` : "#\uFE0F\u20E3 Canal";
            channelFilterBtn.classList.add("gs-view-btn-active");
        } else if (this._excludedChannels.size > 0) {
            channelFilterBtn.textContent = `#\uFE0F\u20E3 -${this._excludedChannels.size}`;
            channelFilterBtn.classList.add("gs-view-btn-active");
        } else {
            channelFilterBtn.textContent = "#\uFE0F\u20E3 Canal";
        }

        const countLabel = document.createElement("span");
        countLabel.className = "gs-result-count";
        countLabel.textContent = `${results.length} resultado(s)`;

        viewBar.prepend(viewLabel);
        viewBar.appendChild(countLabel);
        container.appendChild(viewBar);

        // Apply current channel filters and re-render
        const applyChannelFilter = () => {
            let filtered;
            if (this._activeChannelFilter) {
                filtered = results.filter(m => `${m.guildId}:${m.channelId}` === this._activeChannelFilter);
            } else if (this._excludedChannels.size > 0) {
                filtered = results.filter(m => !this._excludedChannels.has(`${m.guildId}:${m.channelId}`));
            } else {
                filtered = results;
            }
            countLabel.textContent = filtered.length === results.length
                ? `${results.length} resultado(s)`
                : `${filtered.length} de ${results.length} resultado(s)`;
            const isActive = this._activeChannelFilter !== null || this._excludedChannels.size > 0;
            channelFilterBtn.classList.toggle("gs-view-btn-active", isActive);
            if (!isActive) channelFilterBtn.textContent = "#\uFE0F\u20E3 Canal";
            this._renderResultItems(resultsList, filtered, overlay);
        };

        // Channel filter dropdown panel
        const channelDropdown = document.createElement("div");
        channelDropdown.className = "gs-channel-dropdown";
        channelDropdown.style.display = "none";

        const buildChannelDropdown = () => {
            channelDropdown.innerHTML = "";

            // "All channels" option (reset)
            const allItem = document.createElement("div");
            allItem.className = "gs-channel-item" + (this._activeChannelFilter === null && this._excludedChannels.size === 0 ? " gs-channel-item-active" : "");
            allItem.textContent = `Todos os canais (${results.length})`;
            allItem.addEventListener("click", () => {
                this._activeChannelFilter = null;
                this._excludedChannels.clear();
                channelDropdown.style.display = "none";
                applyChannelFilter();
            });
            channelDropdown.appendChild(allItem);

            // Hint
            const hint = document.createElement("div");
            hint.className = "gs-channel-hint";
            hint.textContent = "Clique = so esse canal | X = esconder canal";
            channelDropdown.appendChild(hint);

            // Sort channels by server > channel name
            const sorted = [...channelMap.values()].sort((a, b) => {
                const g = a.guildName.localeCompare(b.guildName);
                return g !== 0 ? g : a.channelName.localeCompare(b.channelName);
            });

            for (const ch of sorted) {
                const key = `${ch.guildId}:${ch.channelId}`;
                const isExcluded = this._excludedChannels.has(key);
                const isSelected = this._activeChannelFilter === key;
                const item = document.createElement("div");
                item.className = "gs-channel-item" + (isSelected ? " gs-channel-item-active" : "") + (isExcluded ? " gs-channel-item-excluded" : "");
                item.innerHTML = `
                    <span class="gs-channel-item-guild">${this.escapeHtml(ch.guildName)}</span>
                    <span class="gs-channel-item-name">#${this.escapeHtml(ch.channelName)}</span>
                    <span class="gs-channel-item-count">(${ch.count})</span>
                `;

                // Left click: show only this channel
                item.addEventListener("click", (e) => {
                    if (e.target.closest(".gs-channel-exclude")) return; // let exclude button handle it
                    this._activeChannelFilter = isSelected ? null : key;
                    this._excludedChannels.clear();
                    if (this._activeChannelFilter) {
                        channelFilterBtn.textContent = `#${ch.channelName}`;
                    }
                    channelDropdown.style.display = "none";
                    applyChannelFilter();
                });

                // Exclude button (X)
                const excludeBtn = document.createElement("button");
                excludeBtn.className = "gs-channel-exclude";
                excludeBtn.innerHTML = isExcluded ? "&#10003;" : "&times;";
                excludeBtn.title = isExcluded ? "Mostrar este canal" : "Esconder este canal";
                excludeBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this._activeChannelFilter = null;
                    if (isExcluded) {
                        this._excludedChannels.delete(key);
                    } else {
                        this._excludedChannels.add(key);
                    }
                    if (this._excludedChannels.size > 0) {
                        channelFilterBtn.textContent = `#\uFE0F\u20E3 -${this._excludedChannels.size}`;
                    }
                    buildChannelDropdown(); // rebuild to update state
                    applyChannelFilter();
                });
                item.appendChild(excludeBtn);

                channelDropdown.appendChild(item);
            }
        };

        channelFilterBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (channelDropdown.style.display === "none") {
                buildChannelDropdown();
                channelDropdown.style.display = "block";
            } else {
                channelDropdown.style.display = "none";
            }
        });

        // Close dropdown when clicking outside
        overlay.addEventListener("click", (e) => {
            if (!channelFilterBtn.contains(e.target) && !channelDropdown.contains(e.target)) {
                channelDropdown.style.display = "none";
            }
        });

        viewBar.appendChild(channelDropdown);

        // Find bar (hidden by default, toggled by button)
        let findBar = null;
        let findState = { matches: [], currentIndex: -1, filterMode: false };

        const resultsList = document.createElement("div");
        resultsList.className = "gs-results-list";

        const openFindBar = () => {
            if (findBar) { findBar.querySelector(".gs-find-input").focus(); return; }

            findBtn.classList.add("gs-view-btn-active");

            findBar = document.createElement("div");
            findBar.className = "gs-find-bar";
            findBar.innerHTML = `
                <input type="text" class="gs-find-input" placeholder="Buscar nos resultados..."/>
                <span class="gs-find-count">0 de 0</span>
                <button class="gs-find-prev" title="Anterior (Shift+Enter)">\u25B2</button>
                <button class="gs-find-next" title="Proximo (Enter)">\u25BC</button>
                <button class="gs-find-filter" title="Filtrar resultados">\u2263</button>
                <button class="gs-find-close" title="Fechar (Esc)">&times;</button>
            `;

            // Insert between viewBar and resultsList
            container.insertBefore(findBar, resultsList);

            const findInput = findBar.querySelector(".gs-find-input");
            const findCount = findBar.querySelector(".gs-find-count");
            const prevBtn = findBar.querySelector(".gs-find-prev");
            const nextBtn = findBar.querySelector(".gs-find-next");
            const filterBtn = findBar.querySelector(".gs-find-filter");
            const closeBtn = findBar.querySelector(".gs-find-close");

            let debounceTimer = null;

            const clearHighlights = () => {
                resultsList.querySelectorAll("mark.gs-highlight").forEach(mark => {
                    const parent = mark.parentNode;
                    parent.replaceChild(document.createTextNode(mark.textContent), mark);
                    parent.normalize();
                });
                resultsList.querySelectorAll(".gs-result-item").forEach(item => {
                    item.classList.remove("gs-filtered-out");
                });
                findState.matches = [];
                findState.currentIndex = -1;
            };

            const doFind = () => {
                clearHighlights();
                const query = findInput.value.trim().toLowerCase();
                if (!query) {
                    findCount.textContent = "0 de 0";
                    return;
                }

                const items = resultsList.querySelectorAll(".gs-result-item");
                const allMarks = [];

                items.forEach(item => {
                    let hasMatch = false;
                    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, null);
                    const textNodes = [];
                    while (walker.nextNode()) textNodes.push(walker.currentNode);

                    for (const textNode of textNodes) {
                        const text = textNode.textContent;
                        const lowerText = text.toLowerCase();
                        let idx = lowerText.indexOf(query);
                        if (idx === -1) continue;
                        hasMatch = true;

                        const fragment = document.createDocumentFragment();
                        let lastIdx = 0;
                        while (idx !== -1) {
                            if (idx > lastIdx) {
                                fragment.appendChild(document.createTextNode(text.substring(lastIdx, idx)));
                            }
                            const mark = document.createElement("mark");
                            mark.className = "gs-highlight";
                            mark.textContent = text.substring(idx, idx + query.length);
                            fragment.appendChild(mark);
                            allMarks.push(mark);
                            lastIdx = idx + query.length;
                            idx = lowerText.indexOf(query, lastIdx);
                        }
                        if (lastIdx < text.length) {
                            fragment.appendChild(document.createTextNode(text.substring(lastIdx)));
                        }
                        textNode.parentNode.replaceChild(fragment, textNode);
                    }

                    if (findState.filterMode && !hasMatch) {
                        item.classList.add("gs-filtered-out");
                    }
                });

                findState.matches = allMarks;
                if (allMarks.length > 0) {
                    findState.currentIndex = 0;
                    allMarks[0].classList.add("gs-highlight-active");
                    allMarks[0].scrollIntoView({ block: "center", behavior: "smooth" });
                }
                findCount.textContent = allMarks.length > 0
                    ? `1 de ${allMarks.length}`
                    : "0 de 0";
            };

            const goToMatch = (direction) => {
                if (findState.matches.length === 0) return;
                findState.matches[findState.currentIndex]?.classList.remove("gs-highlight-active");
                findState.currentIndex = (findState.currentIndex + direction + findState.matches.length) % findState.matches.length;
                const current = findState.matches[findState.currentIndex];
                current.classList.add("gs-highlight-active");
                current.scrollIntoView({ block: "center", behavior: "smooth" });
                findCount.textContent = `${findState.currentIndex + 1} de ${findState.matches.length}`;
            };

            const closeFindBar = () => {
                clearHighlights();
                findBar.remove();
                findBar = null;
                findBtn.classList.remove("gs-view-btn-active");
            };

            findInput.addEventListener("input", () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(doFind, 150);
            });

            findInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && e.shiftKey) {
                    e.preventDefault();
                    goToMatch(-1);
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    goToMatch(1);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    closeFindBar();
                }
            });

            prevBtn.addEventListener("click", () => goToMatch(-1));
            nextBtn.addEventListener("click", () => goToMatch(1));

            filterBtn.addEventListener("click", () => {
                findState.filterMode = !findState.filterMode;
                filterBtn.classList.toggle("gs-find-filter-active", findState.filterMode);
                doFind();
            });

            closeBtn.addEventListener("click", closeFindBar);

            findInput.focus();
        };

        findBtn.addEventListener("click", () => {
            if (findBar) {
                // Close if already open
                const closeBtn = findBar.querySelector(".gs-find-close");
                if (closeBtn) closeBtn.click();
            } else {
                openFindBar();
            }
        });

        container.appendChild(resultsList);

        // Apply persisted channel filters on initial render
        applyChannelFilter();
    }

    _renderResultItems(container, results, overlay) {
        container.innerHTML = "";
        const mode = this.settings.viewMode || "traditional";

        for (const msg of results) {
            const item = document.createElement("div");
            item.className = `gs-result-item gs-mode-${mode}`;

            const date = new Date(msg.timestamp);
            const dateStr = date.toLocaleDateString("pt-BR") + " " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
            const hasAttachments = msg.attachments && msg.attachments.length > 0;

            if (mode === "compact") {
                // Compact: single line — date | server > #channel | author: message
                const content = msg.content.length > 120 ? msg.content.substring(0, 120) + "..." : msg.content;
                item.innerHTML = `
                    <span class="gs-compact-date">${dateStr}</span>
                    <span class="gs-compact-location">${this.escapeHtml(msg.guildName)} &gt; #${this.escapeHtml(msg.channelName)}</span>
                    <span class="gs-compact-author">${this.escapeHtml(msg.author)}:</span>
                    <span class="gs-compact-content">${this.escapeHtml(content)}</span>
                    ${hasAttachments ? `<span class="gs-attachment-badge">${msg.attachments.length}</span>` : ""}
                `;
            } else if (mode === "detailed") {
                // Detailed: avatar, full content, embeds info
                const content = msg.content.length > 800 ? msg.content.substring(0, 800) + "..." : msg.content;
                const avatarHtml = msg.authorAvatar
                    ? `<img class="gs-detail-avatar" src="${msg.authorAvatar}" onerror="this.style.display='none'"/>`
                    : `<div class="gs-detail-avatar gs-detail-avatar-fallback">${msg.author.charAt(0).toUpperCase()}</div>`;
                item.innerHTML = `
                    <div class="gs-detail-top">
                        <div class="gs-result-guild">
                            ${msg.guildIcon ? `<img class="gs-guild-icon" src="${msg.guildIcon}" onerror="this.style.display='none'"/>` : ""}
                            <strong>${this.escapeHtml(msg.guildName)}</strong>
                            <span class="gs-channel-name">#${this.escapeHtml(msg.channelName)}</span>
                        </div>
                        <span class="gs-result-date">${dateStr}</span>
                    </div>
                    <div class="gs-detail-body">
                        ${avatarHtml}
                        <div class="gs-detail-msg">
                            <span class="gs-result-author">${this.escapeHtml(msg.author)}</span>
                            <div class="gs-result-content">${this.escapeHtml(content)}</div>
                            ${hasAttachments ? `<div class="gs-detail-attachments">${msg.attachments.map(a => `<span class="gs-attachment-badge">${this.escapeHtml(a.filename || "anexo")}</span>`).join(" ")}</div>` : ""}
                            ${msg.embeds && msg.embeds.length > 0 ? `<div class="gs-detail-attachments"><span class="gs-attachment-badge">${msg.embeds.length} embed(s)</span></div>` : ""}
                        </div>
                    </div>
                `;
            } else {
                // Traditional (default)
                const content = msg.content.length > 300 ? msg.content.substring(0, 300) + "..." : msg.content;
                item.innerHTML = `
                    <div class="gs-result-header">
                        <div class="gs-result-guild">
                            ${msg.guildIcon ? `<img class="gs-guild-icon" src="${msg.guildIcon}" onerror="this.style.display='none'"/>` : ""}
                            <strong>${this.escapeHtml(msg.guildName)}</strong>
                            <span class="gs-channel-name">#${this.escapeHtml(msg.channelName)}</span>
                        </div>
                        <span class="gs-result-date">${dateStr}</span>
                    </div>
                    <div class="gs-result-body">
                        <span class="gs-result-author">${this.escapeHtml(msg.author)}:</span>
                        <span class="gs-result-content">${this.escapeHtml(content)}</span>
                        ${hasAttachments ? `<span class="gs-attachment-badge">${msg.attachments.length} anexo(s)</span>` : ""}
                    </div>
                `;
            }

            item.title = "Clique para ir a mensagem | Clique direito para abrir DM";

            // Left click: go to message (original behavior)
            item.addEventListener("click", () => {
                this.goToMessage(msg.guildId, msg.channelId, msg.id);
                overlay.remove();
            });

            // Right click: open DM with author + prepare message in chat box
            item.addEventListener("contextmenu", async (e) => {
                e.preventDefault();
                if (!msg.authorId) {
                    BdApi.UI.showToast("ID do autor nao disponivel.", { type: "error" });
                    return;
                }
                BdApi.UI.showToast(`Abrindo DM com ${msg.author}...`, { type: "info" });
                const dmChannel = await this.openDMWithUser(msg.authorId);
                if (dmChannel) {
                    overlay.remove();
                    // Prepare message text in the chat input box
                    await this.sleep(800);
                    this.insertTextInChatBox(msg);
                }
            });

            container.appendChild(item);
        }
    }

    escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    // ========== STYLES ==========

    injectStyles() {
        BdApi.DOM.addStyle(this.styleId, `
            /* Toolbar button */
            .global-search-toolbar-btn {
                cursor: pointer;
                color: var(--interactive-normal, #b5bac1);
                padding: 4px 8px;
                display: flex;
                align-items: center;
                border-radius: 4px;
                transition: color 0.15s, background 0.15s;
            }
            .global-search-toolbar-btn:hover {
                color: var(--interactive-hover, #fff);
                background: var(--background-modifier-hover, rgba(255,255,255,0.1));
            }

            /* Modal overlay */
            .gs-modal-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.7);
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: gs-fade-in 0.15s ease;
            }
            @keyframes gs-fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            /* Modal */
            .gs-modal {
                background: var(--modal-background, var(--background-primary, #313338));
                border-radius: 8px;
                width: 680px;
                max-width: 90vw;
                max-height: 85vh;
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                animation: gs-slide-in 0.2s ease;
                overflow: hidden;
            }
            @keyframes gs-slide-in {
                from { transform: translateY(-20px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }

            /* Header */
            .gs-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 20px;
                border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                background: var(--modal-background, var(--background-secondary, #2b2d31));
            }
            .gs-modal-header h2 {
                margin: 0;
                color: var(--header-primary, #f2f3f5);
                font-size: 20px;
            }
            .gs-close {
                cursor: pointer;
                font-size: 24px;
                color: var(--interactive-normal, #b5bac1);
                padding: 4px 8px;
                border-radius: 4px;
                line-height: 1;
            }
            .gs-close:hover {
                color: var(--interactive-hover, #fff);
                background: var(--background-modifier-hover, rgba(255,255,255,0.1));
            }

            /* Search area */
            .gs-search-area {
                display: flex;
                gap: 8px;
                padding: 16px 20px 8px;
            }
            .gs-search-input {
                flex: 1;
                padding: 10px 14px;
                border-radius: 6px;
                border: 1px solid var(--background-tertiary, #1e1f22);
                background: var(--input-background, var(--background-tertiary, #1e1f22));
                color: var(--text-normal, #f2f3f5);
                font-size: 15px;
                outline: none;
                transition: border-color 0.15s;
            }
            .gs-search-input:focus {
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-search-input::placeholder {
                color: var(--text-muted, #6d6f78);
            }
            .gs-search-btn {
                padding: 10px 20px;
                border-radius: 6px;
                border: none;
                background: var(--brand-experiment, #5865f2);
                color: #fff;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.15s;
                white-space: nowrap;
            }
            .gs-search-btn:hover:not(:disabled) {
                background: var(--brand-experiment-560, #4752c4);
            }
            .gs-search-btn:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }
            .gs-refresh-btn {
                padding: 10px 14px;
                border-radius: 6px;
                border: 1px solid var(--brand-experiment, #5865f2);
                background: transparent;
                color: var(--brand-experiment, #5865f2);
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.15s, color 0.15s;
                white-space: nowrap;
            }
            .gs-refresh-btn:hover:not(:disabled) {
                background: var(--brand-experiment, #5865f2);
                color: #fff;
            }
            .gs-refresh-btn:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }

            /* History dropdown */
            .gs-history-wrapper {
                position: relative;
                padding: 0 20px;
            }
            .gs-history-dropdown {
                position: absolute;
                top: 0;
                left: 20px;
                right: 20px;
                background: var(--background-floating, var(--background-secondary, #2b2d31));
                border: 1px solid var(--background-modifier-accent, #3f4147);
                border-radius: 6px;
                box-shadow: 0 4px 16px rgba(0,0,0,0.4);
                z-index: 10;
                max-height: 280px;
                overflow-y: auto;
            }
            .gs-history-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 12px 4px;
                color: var(--text-muted, #949ba4);
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
            }
            .gs-history-clear {
                background: none;
                border: none;
                color: var(--status-danger, #f23f43);
                font-size: 11px;
                cursor: pointer;
                padding: 2px 6px;
                border-radius: 3px;
            }
            .gs-history-clear:hover {
                background: var(--status-danger, #f23f43);
                color: #fff;
            }
            .gs-history-item {
                padding: 8px 12px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
                transition: background 0.1s;
            }
            .gs-history-item:hover {
                background: var(--background-modifier-hover, rgba(255,255,255,0.06));
            }
            .gs-history-query {
                color: var(--text-normal, #dbdee1);
                font-size: 13px;
                font-weight: 500;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .gs-history-meta {
                color: var(--text-muted, #949ba4);
                font-size: 11px;
                flex-shrink: 0;
                white-space: nowrap;
            }
            .gs-history-empty {
                padding: 16px;
                text-align: center;
                color: var(--text-muted, #949ba4);
                font-size: 13px;
            }

            /* Auto-refresh toggle */
            .gs-auto-refresh-toggle {
                display: flex;
                align-items: center;
                gap: 5px;
                color: var(--text-muted, #949ba4);
                font-size: 12px;
                cursor: pointer;
                margin-left: 8px;
                padding: 3px 8px;
                border-radius: 4px;
                border: 1px solid var(--background-modifier-accent, #3f4147);
                background: var(--background-secondary, #2b2d31);
                transition: border-color 0.15s;
            }
            .gs-auto-refresh-toggle:hover {
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-auto-refresh-toggle input:checked + span {
                color: var(--text-normal, #dbdee1);
            }

            /* Guild section */
            .gs-guild-section {
                padding: 8px 20px;
            }
            .gs-guild-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .gs-checkbox-label {
                display: flex;
                align-items: center;
                gap: 6px;
                color: var(--text-normal, #dbdee1);
                font-size: 14px;
                cursor: pointer;
            }
            .gs-toggle-guilds {
                background: none;
                border: none;
                color: var(--text-link, #00a8fc);
                font-size: 13px;
                cursor: pointer;
                padding: 4px 8px;
            }
            .gs-toggle-guilds:hover {
                text-decoration: underline;
            }
            .gs-folder-area {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                padding: 8px 20px 4px;
            }
            .gs-folder-btn {
                padding: 4px 10px;
                border-radius: 4px;
                border: 1px solid var(--background-modifier-accent, #3f4147);
                background: var(--background-secondary, #2b2d31);
                color: var(--text-normal, #dbdee1);
                font-size: 12px;
                cursor: pointer;
                transition: background 0.15s, border-color 0.15s;
                white-space: nowrap;
            }
            .gs-folder-btn:hover {
                background: var(--background-modifier-hover, rgba(255,255,255,0.06));
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-folder-btn-active {
                background: var(--brand-experiment, #5865f2);
                color: #fff;
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-guild-filter {
                width: 100%;
                padding: 8px 12px;
                margin-top: 8px;
                border-radius: 4px;
                border: 1px solid var(--background-tertiary, #1e1f22);
                background: var(--input-background, var(--background-tertiary, #1e1f22));
                color: var(--text-normal, #f2f3f5);
                font-size: 13px;
                outline: none;
                box-sizing: border-box;
            }
            .gs-guild-filter:focus {
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-guild-filter::placeholder {
                color: var(--text-muted, #6d6f78);
            }
            .gs-guild-count {
                color: var(--text-muted, #949ba4);
                font-size: 12px;
                margin-left: 4px;
            }
            .gs-guild-list {
                max-height: 150px;
                overflow-y: auto;
                margin-top: 8px;
                padding: 8px;
                background: var(--background-secondary, #2b2d31);
                border-radius: 6px;
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 4px;
            }
            .gs-guild-item {
                padding: 4px 6px;
                border-radius: 4px;
                font-size: 13px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .gs-guild-item:hover {
                background: var(--background-modifier-hover, rgba(255,255,255,0.06));
            }
            .gs-guild-icon {
                width: 20px;
                height: 20px;
                border-radius: 50%;
                vertical-align: middle;
                flex-shrink: 0;
            }

            /* Progress */
            .gs-progress {
                padding: 8px 20px;
                color: var(--text-muted, #949ba4);
                font-size: 13px;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .gs-progress-bar-bg {
                width: 100%;
                height: 6px;
                background: var(--background-tertiary, #1e1f22);
                border-radius: 3px;
                overflow: hidden;
            }
            .gs-progress-bar {
                height: 100%;
                background: var(--brand-experiment, #5865f2);
                border-radius: 3px;
                transition: width 0.3s ease;
            }
            .gs-progress-info {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .gs-cancel-btn {
                padding: 3px 12px;
                border-radius: 4px;
                border: 1px solid var(--status-danger, #f23f43);
                background: transparent;
                color: var(--status-danger, #f23f43);
                font-size: 12px;
                cursor: pointer;
                transition: background 0.15s;
                flex-shrink: 0;
            }
            .gs-cancel-btn:hover {
                background: var(--status-danger, #f23f43);
                color: #fff;
            }

            /* Results */
            .gs-results {
                flex: 1;
                overflow-y: auto;
                padding: 8px 20px 16px;
            }
            .gs-no-results {
                text-align: center;
                color: var(--text-muted, #949ba4);
                padding: 40px 0;
                font-size: 15px;
            }
            .gs-result-item {
                padding: 10px 12px;
                border-radius: 6px;
                cursor: pointer;
                transition: background 0.1s;
                border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
            }
            .gs-result-item:last-child {
                border-bottom: none;
            }
            .gs-result-item:hover {
                background: var(--background-modifier-hover, rgba(255,255,255,0.06));
            }
            .gs-result-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 4px;
            }
            .gs-result-guild {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 13px;
                color: var(--text-normal, #dbdee1);
            }
            .gs-channel-name {
                color: var(--text-muted, #949ba4);
                font-size: 12px;
            }
            .gs-result-date {
                color: var(--text-muted, #949ba4);
                font-size: 12px;
                flex-shrink: 0;
            }
            .gs-result-body {
                font-size: 14px;
                color: var(--text-normal, #dbdee1);
                line-height: 1.4;
            }
            .gs-result-author {
                font-weight: 600;
                margin-right: 4px;
            }
            .gs-result-content {
                color: var(--text-normal, #dbdee1);
                word-break: break-word;
            }
            .gs-attachment-badge {
                display: inline-block;
                background: var(--background-tertiary, #1e1f22);
                color: var(--text-muted, #949ba4);
                font-size: 11px;
                padding: 2px 6px;
                border-radius: 3px;
                margin-left: 6px;
            }

            /* View mode bar */
            .gs-view-bar {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 0 10px;
                border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                margin-bottom: 8px;
                flex-wrap: wrap;
            }
            .gs-view-label {
                color: var(--text-muted, #949ba4);
                font-size: 12px;
                margin-right: 2px;
            }
            .gs-view-btn {
                padding: 3px 10px;
                border-radius: 4px;
                border: 1px solid var(--background-modifier-accent, #3f4147);
                background: var(--background-secondary, #2b2d31);
                color: var(--text-normal, #dbdee1);
                font-size: 12px;
                cursor: pointer;
                transition: background 0.15s, border-color 0.15s;
            }
            .gs-view-btn:hover {
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-view-btn-active {
                background: var(--brand-experiment, #5865f2);
                color: #fff;
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-result-count {
                margin-left: auto;
                color: var(--text-muted, #949ba4);
                font-size: 12px;
            }

            /* Compact mode */
            .gs-mode-compact {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 4px 8px !important;
                font-size: 13px;
                white-space: nowrap;
                overflow: hidden;
            }
            .gs-compact-date {
                color: var(--text-muted, #949ba4);
                font-size: 11px;
                flex-shrink: 0;
                min-width: 100px;
            }
            .gs-compact-location {
                color: var(--text-muted, #72767d);
                font-size: 12px;
                flex-shrink: 0;
                max-width: 200px;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .gs-compact-author {
                font-weight: 600;
                color: var(--text-normal, #dbdee1);
                flex-shrink: 0;
            }
            .gs-compact-content {
                color: var(--text-normal, #dbdee1);
                overflow: hidden;
                text-overflow: ellipsis;
            }

            /* Detailed mode */
            .gs-mode-detailed {
                padding: 12px !important;
            }
            .gs-detail-top {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 8px;
            }
            .gs-detail-body {
                display: flex;
                gap: 10px;
                align-items: flex-start;
            }
            .gs-detail-avatar {
                width: 36px;
                height: 36px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            .gs-detail-avatar-fallback {
                background: var(--brand-experiment, #5865f2);
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                font-size: 16px;
            }
            .gs-detail-msg {
                flex: 1;
                min-width: 0;
            }
            .gs-detail-msg .gs-result-author {
                display: block;
                margin-bottom: 2px;
            }
            .gs-detail-msg .gs-result-content {
                white-space: pre-wrap;
            }
            .gs-detail-attachments {
                margin-top: 6px;
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
            }

            /* Period selector */
            .gs-period-area {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 4px 20px 8px;
            }
            .gs-period-label {
                color: var(--text-muted, #949ba4);
                font-size: 12px;
            }
            .gs-period-select {
                padding: 4px 8px;
                border-radius: 4px;
                border: 1px solid var(--background-tertiary, #1e1f22);
                background: var(--input-background, var(--background-tertiary, #1e1f22));
                color: var(--text-normal, #f2f3f5);
                font-size: 13px;
                outline: none;
                cursor: pointer;
            }
            .gs-period-select:focus {
                border-color: var(--brand-experiment, #5865f2);
            }

            /* Fuzzy / custom variants */
            .gs-fuzzy-area {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 0 20px 8px;
                flex-wrap: wrap;
            }
            .gs-fuzzy-input {
                flex: 1;
                min-width: 200px;
                padding: 5px 10px;
                border-radius: 4px;
                border: 1px solid var(--background-tertiary, #1e1f22);
                background: var(--input-background, var(--background-tertiary, #1e1f22));
                color: var(--text-normal, #f2f3f5);
                font-size: 13px;
                outline: none;
            }
            .gs-fuzzy-input:focus {
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-fuzzy-input::placeholder {
                color: var(--text-muted, #6d6f78);
            }

            /* Exclude words */
            .gs-exclude-area {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 0 20px 8px;
                flex-wrap: wrap;
            }
            .gs-exclude-input {
                flex: 1;
                min-width: 200px;
                padding: 5px 10px;
                border-radius: 4px;
                border: 1px solid var(--background-tertiary, #1e1f22);
                background: var(--input-background, var(--background-tertiary, #1e1f22));
                color: var(--text-normal, #f2f3f5);
                font-size: 13px;
                outline: none;
            }
            .gs-exclude-input:focus {
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-exclude-input::placeholder {
                color: var(--text-muted, #6d6f78);
            }
            .gs-exclude-help {
                color: var(--text-muted, #6d6f78);
                font-size: 11px;
                width: 100%;
            }

            /* ===== History action buttons ===== */
            .gs-history-actions {
                display: flex;
                align-items: center;
                gap: 2px;
                flex-shrink: 0;
                margin-left: auto;
            }
            .gs-history-item {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .gs-history-delete {
                background: none;
                border: none;
                color: var(--text-muted, #949ba4);
                font-size: 16px;
                cursor: pointer;
                padding: 2px 6px;
                border-radius: 3px;
                flex-shrink: 0;
                line-height: 1;
                opacity: 0;
                transition: opacity 0.15s, color 0.15s;
            }
            .gs-history-item:hover .gs-history-delete {
                opacity: 1;
            }
            .gs-history-delete:hover {
                color: var(--status-danger, #f23f43);
                background: rgba(242, 63, 67, 0.1);
            }
            .gs-history-archive {
                background: none;
                border: none;
                color: var(--text-muted, #949ba4);
                font-size: 14px;
                cursor: pointer;
                padding: 2px 4px;
                border-radius: 3px;
                flex-shrink: 0;
                opacity: 0;
                transition: opacity 0.15s, color 0.15s;
            }
            .gs-history-item:hover .gs-history-archive {
                opacity: 1;
            }
            .gs-history-archive-active {
                color: var(--brand-experiment, #5865f2);
                opacity: 1 !important;
            }
            .gs-history-archive:hover {
                color: var(--brand-experiment-560, #4752c4);
            }

            /* ===== Archived section ===== */
            .gs-archive-header {
                background: rgba(88, 101, 242, 0.05);
            }
            .gs-archived-item {
                border-left: 2px solid var(--brand-experiment, #5865f2);
            }
            .gs-storage-size {
                color: var(--text-muted, #949ba4);
                font-size: 11px;
                font-weight: normal;
            }

            /* ===== Pause/Resume buttons ===== */
            .gs-pause-btn {
                padding: 3px 12px;
                border-radius: 4px;
                border: 1px solid var(--brand-experiment, #5865f2);
                background: transparent;
                color: var(--brand-experiment, #5865f2);
                font-size: 12px;
                cursor: pointer;
                transition: background 0.15s;
                flex-shrink: 0;
            }
            .gs-pause-btn:hover {
                background: var(--brand-experiment, #5865f2);
                color: #fff;
            }
            .gs-resume-btn {
                padding: 3px 12px;
                border-radius: 4px;
                border: none;
                background: var(--brand-experiment, #5865f2);
                color: #fff;
                font-size: 12px;
                cursor: pointer;
                font-weight: 600;
                transition: background 0.15s;
                flex-shrink: 0;
            }
            .gs-resume-btn:hover {
                background: var(--brand-experiment-560, #4752c4);
            }
            .gs-progress-bar-paused {
                background: var(--text-muted, #949ba4) !important;
            }

            /* ===== Channel filter dropdown ===== */
            .gs-channel-dropdown {
                position: absolute;
                top: 100%;
                right: 0;
                z-index: 1000;
                background: var(--background-floating, #111214);
                border: 1px solid var(--background-modifier-accent, #3f4147);
                border-radius: 8px;
                padding: 6px 0;
                max-height: 300px;
                overflow-y: auto;
                min-width: 250px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            }
            .gs-channel-item {
                padding: 6px 12px;
                cursor: pointer;
                font-size: 13px;
                color: var(--text-normal, #f2f3f5);
                display: flex;
                align-items: center;
                gap: 4px;
                transition: background 0.1s;
            }
            .gs-channel-item:hover {
                background: var(--background-modifier-hover, rgba(79, 84, 92, 0.3));
            }
            .gs-channel-item-active {
                background: rgba(88, 101, 242, 0.15);
                color: var(--brand-experiment, #5865f2);
            }
            .gs-channel-item-guild {
                color: var(--text-muted, #949ba4);
                font-size: 11px;
                flex-shrink: 0;
            }
            .gs-channel-item-name {
                font-weight: 500;
            }
            .gs-channel-item-count {
                color: var(--text-muted, #949ba4);
                font-size: 11px;
                margin-left: auto;
                flex-shrink: 0;
            }
            .gs-channel-filter-btn {
                font-size: 12px !important;
                max-width: 150px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .gs-channel-hint {
                padding: 4px 12px;
                font-size: 10px;
                color: var(--text-muted, #949ba4);
                border-bottom: 1px solid var(--background-modifier-accent, #3f4147);
                margin-bottom: 2px;
            }
            .gs-channel-exclude {
                background: none;
                border: none;
                color: var(--text-muted, #949ba4);
                font-size: 14px;
                cursor: pointer;
                padding: 2px 6px;
                border-radius: 3px;
                margin-left: auto;
                flex-shrink: 0;
                opacity: 0;
                transition: opacity 0.15s, color 0.15s;
                line-height: 1;
            }
            .gs-channel-item:hover .gs-channel-exclude {
                opacity: 1;
            }
            .gs-channel-exclude:hover {
                color: var(--status-danger, #f23f43);
                background: rgba(242, 63, 67, 0.1);
            }
            .gs-channel-item-excluded {
                opacity: 0.5;
                text-decoration: line-through;
            }
            .gs-channel-item-excluded .gs-channel-exclude {
                opacity: 1;
                color: var(--status-positive, #23a55a);
            }

            /* Make view bar position relative for dropdown */
            .gs-view-bar {
                position: relative;
            }

            /* ===== View bar find button ===== */
            .gs-view-separator {
                color: var(--text-muted, #949ba4);
                font-size: 14px;
                margin: 0 2px;
                user-select: none;
            }
            .gs-find-toggle-btn {
                font-size: 12px !important;
            }

            /* ===== Find bar ===== */
            .gs-find-bar {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 10px;
                background: var(--background-secondary, #2b2d31);
                border: 1px solid var(--background-modifier-accent, #3f4147);
                border-radius: 6px;
                margin-bottom: 8px;
                flex-shrink: 0;
            }
            .gs-find-input {
                flex: 1;
                background: var(--background-tertiary, #1e1f22);
                border: 1px solid var(--background-modifier-accent, #3f4147);
                border-radius: 4px;
                padding: 4px 8px;
                color: var(--text-normal, #f2f3f5);
                font-size: 13px;
                outline: none;
                min-width: 120px;
            }
            .gs-find-input:focus {
                border-color: var(--brand-experiment, #5865f2);
            }
            .gs-find-count {
                color: var(--text-muted, #949ba4);
                font-size: 12px;
                white-space: nowrap;
                min-width: 50px;
                text-align: center;
            }
            .gs-find-prev, .gs-find-next, .gs-find-filter, .gs-find-close {
                background: none;
                border: none;
                color: var(--text-muted, #949ba4);
                font-size: 14px;
                cursor: pointer;
                padding: 2px 6px;
                border-radius: 3px;
                transition: color 0.15s, background 0.15s;
                line-height: 1;
            }
            .gs-find-prev:hover, .gs-find-next:hover, .gs-find-close:hover {
                color: var(--text-normal, #f2f3f5);
                background: var(--background-modifier-hover, rgba(79, 84, 92, 0.3));
            }
            .gs-find-filter:hover {
                color: var(--brand-experiment, #5865f2);
            }
            .gs-find-filter-active {
                color: var(--brand-experiment, #5865f2) !important;
                background: rgba(88, 101, 242, 0.15);
            }

            /* Highlights */
            mark.gs-highlight {
                background: rgba(255, 235, 59, 0.35);
                color: inherit;
                border-radius: 2px;
                padding: 0 1px;
            }
            mark.gs-highlight-active {
                background: rgba(255, 152, 0, 0.6);
                color: inherit;
            }
            .gs-filtered-out {
                display: none !important;
            }
        `);
    }

    removeStyles() {
        BdApi.DOM.removeStyle(this.styleId);
    }
};
