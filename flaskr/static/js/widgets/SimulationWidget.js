import BaseWidget from './BaseWidget.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Simulação da manobra (botão SIMULAR do painel Manobras).
 *
 * Usa o estado TRAVADO no momento do clique e mostra, no mesmo relógio:
 *   1. a vista orbital: órbita alvo (400 km), percurso planejado tracejado de quem
 *      manobra, o caminho já percorrido, os impulsos e a posição-alvo de cada satélite;
 *   2. distância até a Gabriella x tempo (limites 1000 e 2000 km);
 *   3. altitude de quem está em correção x tempo (limites 300 e 450 km).
 * Escala de tempo padrão: 20 min de missão = 1 s de simulação (1 h = 3 s).
 */

const CORES = { Gabriella: 0xd03379, Beatriz: 0x22d3ee, Carolina: 0xf59e0b };
const CSS = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const NOMES_ESTRATEGIA = ['1º cruzamento', '2º cruzamento', 'Faseamento'];

// Vista: a altitude é exagerada para que dezenas de km apareçam ao lado de uma órbita
// de 6771 km de raio. Os ângulos (e portanto a separação entre os satélites) são reais.
const R_ORBITA = 100;        // raio na tela da órbita de 400 km
const EXAGERO = 0.5;         // unidades de tela por km de altitude
const R_TERRA_TELA = 40;     // a Terra é só referência visual (fora de escala)

const LIMITES_DIST = [1000, 2000];
const LIMITES_ALT = [300, 450];

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function normalizaAngulo(a) {
    return Math.atan2(Math.sin(a), Math.cos(a));
}

class SimulationWidget extends BaseWidget {
    static widgetType = 'simulacao';

    constructor(title, idContainerDestino, frozenPayload, deps = {}) {
        super(title, idContainerDestino);
        this.ephemeral = true;          // não entra no layout salvo do modo
        this.frozen = frozenPayload;
        this.deps = deps;
        this.sim = null;
        this.simH = 0;
        this.playing = false;
        this.segundosPorHora = 3;      // 20 min de missão = 1 s
        this.frame = 'inercial';
        this.lastTs = null;
        this.lastChartUpdate = 0;
        this.isRunning = true;
        this.objects = {};

        this.element.classList.add('simulation-widget');
        this.element.style.width = '1100px';
        this.element.style.height = '620px';

        this.buildLayout();
        this.initThree();
        this.initCharts();
        this.observeResize();

        this.closeWidget.addEventListener('click', () => this.cleanup());

        this.requestSimulation();
        this.loop = this.loop.bind(this);
        requestAnimationFrame(this.loop);
    }

    // ------------------------------------------------------------------ layout
    buildLayout() {
        const sats = Object.values(this.frozen?.satelites || {}).filter((s) => Number.isFinite(s.dKm));
        this.satsFrozen = sats;

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'sim-toolbar';
        this.toolbar.innerHTML = `
            <button type="button" class="mnv-btn" data-action="play" title="Reproduzir / pausar">▶</button>
            <button type="button" class="mnv-btn" data-action="restart" title="Voltar ao início">⟲</button>
            <label>VELOCIDADE
                <select data-role="speed">
                    <option value="3" selected>20 min = 1 s</option>
                    <option value="1">1 h = 1 s</option>
                    <option value="10">6 min = 1 s</option>
                </select>
            </label>
            <label>VISTA
                <select data-role="frame">
                    <option value="inercial">Inercial (órbita inteira)</option>
                    <option value="gabriella">Seguindo a Gabriella</option>
                </select>
            </label>
            <span class="sim-clock" data-role="clock">T+ 0,00 h</span>
            <span class="mnv-spacer"></span>
            <button type="button" class="mnv-btn mnv-btn-force" data-action="live" title="Destrava os dados e fecha a simulação">VOLTAR AO VIVO</button>
        `;

        this.plans = document.createElement('div');
        this.plans.className = 'sim-plans';
        const travado = this.frozen?.timestamp
            ? new Date(this.frozen.timestamp).toLocaleTimeString('pt-BR', { hour12: false }) : '--:--:--';
        this.plans.innerHTML = `<span class="sim-frozen">DADOS TRAVADOS ÀS ${esc(travado)}</span>` +
            sats.map((sat) => this.planSelect(sat)).join('') +
            `<span class="sim-status" data-role="status"></span>`;

        this.main = document.createElement('div');
        this.main.className = 'sim-main';

        this.view = document.createElement('div');
        this.view.className = 'sim-view';
        this.labels = document.createElement('div');
        this.labels.className = 'sim-labels';
        this.legend = document.createElement('div');
        this.legend.className = 'sim-legend';
        this.legend.innerHTML = `
            <span><i style="background:#22c55e"></i>órbita alvo (400 km)</span>
            <span><i class="dash" style="border-color:#94a3b8"></i>percurso planejado</span>
            <span><i class="dot"></i>impulso</span>
            <span><i class="box"></i>posição-alvo</span>
            <span class="sim-muted">altitude exagerada ×${Math.round(EXAGERO * 6771 / R_ORBITA)} · ângulos reais</span>`;
        this.burnList = document.createElement('div');
        this.burnList.className = 'sim-burns';
        this.view.append(this.labels, this.legend, this.burnList);

        this.chartsCol = document.createElement('div');
        this.chartsCol.className = 'sim-charts';
        this.distBox = document.createElement('div');
        this.distBox.className = 'sim-chart';
        this.distCanvas = document.createElement('canvas');
        this.distBox.appendChild(this.distCanvas);
        this.altBox = document.createElement('div');
        this.altBox.className = 'sim-chart';
        this.altCanvas = document.createElement('canvas');
        this.altNote = document.createElement('div');
        this.altNote.className = 'sim-chart-note';
        this.altBox.append(this.altCanvas, this.altNote);
        this.chartsCol.append(this.distBox, this.altBox);

        this.main.append(this.view, this.chartsCol);
        this.content.append(this.toolbar, this.plans, this.main);

        for (const el of [this.toolbar, this.plans]) {
            el.addEventListener('mousedown', (e) => e.stopPropagation());
        }
        this.toolbar.addEventListener('click', (e) => {
            const action = e.target.closest('button')?.dataset.action;
            if (action === 'play') this.togglePlay();
            if (action === 'restart') { this.simH = 0; this.playing = true; this.renderFrame(); }
            if (action === 'live') this.closeWidget.click();
        });
        this.toolbar.querySelector('[data-role="speed"]').addEventListener('change', (e) => {
            this.segundosPorHora = Number(e.target.value) || 3;
            this.updateAxisTitles();
        });
        this.toolbar.querySelector('[data-role="frame"]').addEventListener('change', (e) => {
            this.frame = e.target.value;
            this.buildPaths();
            this.placeCamera();
            this.renderFrame();
        });
        this.plans.addEventListener('change', (e) => {
            if (e.target.dataset.sat) this.requestSimulation();
        });
    }

    planSelect(sat) {
        const opcoes = (sat.estrategias || [])
            .map((e, i) => ({ e, i }))
            .filter(({ e }) => e.viavel)
            .map(({ e, i }) => `<option value="${i}" ${sat.melhor === i ? 'selected' : ''}>
                (${i + 1}) ${esc(e.nome)} · ΔV ${e.dvTotal.toFixed(1)} m/s · ${(e.duracaoMin / 60).toFixed(1)} h</option>`)
            .join('');
        const semManobra = `<option value="" ${Number.isInteger(sat.melhor) ? '' : 'selected'}>sem manobra (só órbita atual)</option>`;
        return `
            <label class="sim-plan" style="--sat:${CSS(CORES[sat.nome])}">
                <b>${esc(sat.nome)}</b> <small>${esc(sat.status)} · ${sat.dKm.toFixed(0)} km · ${sat.hKm.toFixed(0)} km alt</small>
                <select data-sat="${esc(sat.nome)}">${opcoes}${semManobra}</select>
            </label>`;
    }

    setStatus(text, kind = 'info') {
        const el = this.plans.querySelector('[data-role="status"]');
        el.textContent = text || '';
        el.dataset.kind = kind;
    }

    // ---------------------------------------------------------------- backend
    requestSimulation() {
        if (!this.satsFrozen.length) {
            this.setStatus('Sem medidas de Beatriz/Carolina no momento travado.', 'error');
            return;
        }
        const satelites = {};
        for (const sat of this.satsFrozen) {
            const value = this.plans.querySelector(`select[data-sat="${sat.nome}"]`)?.value;
            satelites[sat.nome] = { h: sat.hKm, d: sat.dKm, estrategia: value === '' || value == null ? null : Number(value) };
        }
        if (typeof this.deps.requestSimulation !== 'function') {
            this.setStatus('Sem conexão com o backend.', 'error');
            return;
        }
        this.playing = false;
        this.setStatus('Propagando as órbitas...', 'info');
        this.deps.requestSimulation({ satelites }, (response) => {
            if (!this.isRunning) return;
            if (!response?.ok) {
                this.setStatus(response?.message || 'Falha na simulação.', 'error');
                return;
            }
            this.load(response.simulacao);
        });
    }

    load(sim) {
        this.sim = sim;
        this.simH = 0;
        const avisos = Object.entries(sim.satelites)
            .filter(([, s]) => s.aviso).map(([n, s]) => `${n}: ${s.aviso}`);
        this.setStatus(avisos.join(' ') ||
            `Duração ${sim.duracaoH.toFixed(1)} h de missão (${(sim.duracaoH * this.segundosPorHora).toFixed(1)} s).`,
            avisos.length ? 'error' : 'ok');
        this.buildScene();
        this.loadCharts();
        this.placeCamera();
        this.playing = true;
        this.renderFrame();
    }

    // ------------------------------------------------------------------ three
    initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x05090d);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
        this.camera.up.set(0, 0, 1);
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.view.prepend(this.renderer.domElement);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;

        this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
        const sun = new THREE.DirectionalLight(0xffffff, 2);
        sun.position.set(150, -200, 300);
        this.scene.add(sun);

        const earth = new THREE.Mesh(
            new THREE.SphereGeometry(R_TERRA_TELA, 48, 32),
            new THREE.MeshStandardMaterial({ color: 0x123a63, emissive: 0x08203a, roughness: 0.8 })
        );
        earth.rotation.x = Math.PI / 2;
        const grid = new THREE.Mesh(
            new THREE.SphereGeometry(R_TERRA_TELA + 0.2, 18, 12),
            new THREE.MeshBasicMaterial({ color: 0x3b82f6, wireframe: true, transparent: true, opacity: 0.12 })
        );
        grid.rotation.x = Math.PI / 2;
        this.scene.add(earth, grid);

        this.dynamic = new THREE.Group();
        this.scene.add(this.dynamic);
        this.placeCamera();
    }

    raioTela(rKm, rRef) {
        return R_ORBITA + (rKm - rRef) * EXAGERO;
    }

    offsetFrame(tSeg) {
        if (this.frame !== 'gabriella' || !this.sim) return 0;
        return Math.PI / 2 - this.sim.constantes.nRef * tSeg;
    }

    polar(rKm, th, tSeg) {
        const rRef = this.sim.constantes.rRef;
        const rd = this.raioTela(rKm, rRef);
        const a = th + this.offsetFrame(tSeg);
        return new THREE.Vector3(rd * Math.cos(a), rd * Math.sin(a), 0);
    }

    ring(altKm, color, dashed, opacity) {
        const pts = [];
        const c = this.sim.constantes;
        const rd = this.raioTela(c.rTerra + altKm, c.rRef);
        for (let i = 0; i <= 256; i++) {
            const a = (i / 256) * Math.PI * 2;
            pts.push(new THREE.Vector3(rd * Math.cos(a), rd * Math.sin(a), 0));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = dashed
            ? new THREE.LineDashedMaterial({ color, dashSize: 2, gapSize: 3, transparent: true, opacity })
            : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
        const line = new THREE.Line(geo, mat);
        if (dashed) line.computeLineDistances();
        return line;
    }

    clearDynamic() {
        this.dynamic.traverse((obj) => {
            obj.geometry?.dispose?.();
            obj.material?.dispose?.();
        });
        this.dynamic.clear();
        this.labels.replaceChildren();
        this.objects = {};
    }

    buildScene() {
        this.clearDynamic();
        const c = this.sim.constantes;
        this.dynamic.add(this.ring(c.hRef, 0x22c55e, false, 0.85));
        this.dynamic.add(this.ring(LIMITES_ALT[1], 0xff6670, true, 0.35));
        this.dynamic.add(this.ring(LIMITES_ALT[0], 0xff6670, true, 0.35));

        const makeSat = (nome, size) => {
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(size, size, size),
                new THREE.MeshStandardMaterial({ color: CORES[nome], emissive: CORES[nome], emissiveIntensity: 0.35 })
            );
            this.dynamic.add(mesh);
            const label = document.createElement('span');
            label.className = 'sim-label';
            label.style.color = CSS(CORES[nome]);
            label.textContent = nome;
            this.labels.appendChild(label);
            return { mesh, label };
        };

        this.objects.Gabriella = makeSat('Gabriella', 5);
        for (const [nome, s] of Object.entries(this.sim.satelites)) {
            const obj = makeSat(nome, 4);
            obj.data = s;
            obj.polares = s.x.map((x, i) => ({ r: Math.hypot(x, s.y[i]), th: Math.atan2(s.y[i], x) }));
            // posição-alvo: no anel de 400 km, a ALPHA da Gabriella (atrás ou à frente)
            obj.slot = new THREE.Mesh(
                new THREE.BoxGeometry(5, 5, 5),
                new THREE.MeshBasicMaterial({ color: CORES[nome], wireframe: true, transparent: true, opacity: 0.55 })
            );
            this.dynamic.add(obj.slot);
            this.objects[nome] = obj;
        }
        this.buildPaths();
    }

    // Percurso planejado (tracejado), caminho percorrido (contínuo) e impulsos.
    // Dependem da vista: na "Seguindo a Gabriella" cada ponto gira com o instante dele.
    buildPaths() {
        if (!this.sim) return;
        const dt = this.sim.dtAmostraS;
        for (const [nome, obj] of Object.entries(this.objects)) {
            if (!obj.data) continue;
            for (const key of ['planned', 'trail', 'burns']) {
                if (obj[key]) {
                    this.dynamic.remove(obj[key]);
                    obj[key].traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
                    obj[key] = null;
                }
            }
            if (!obj.data.manobra) continue;

            const pts = obj.polares.map((p, i) => this.polar(p.r, p.th, i * dt));
            const planned = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(pts),
                new THREE.LineDashedMaterial({ color: CORES[nome], dashSize: 2.5, gapSize: 2, transparent: true, opacity: 0.55 })
            );
            planned.computeLineDistances();
            const trail = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(pts),
                new THREE.LineBasicMaterial({ color: CORES[nome], transparent: true, opacity: 0.95 })
            );
            trail.geometry.setDrawRange(0, 1);

            const burns = new THREE.Group();
            for (const imp of obj.data.impulsos) {
                const p = this.polar(Math.hypot(imp.x, imp.y), Math.atan2(imp.y, imp.x), imp.tH * 3600);
                const dot = new THREE.Mesh(
                    new THREE.SphereGeometry(1.6, 12, 8),
                    new THREE.MeshBasicMaterial({ color: 0xfacc15 })
                );
                dot.position.copy(p);
                burns.add(dot);
            }
            obj.planned = planned;
            obj.trail = trail;
            obj.burns = burns;
            this.dynamic.add(planned, trail, burns);
        }
    }

    placeCamera() {
        if (this.frame === 'gabriella') {
            this.controls.target.set(0, R_ORBITA, 0);
            this.camera.position.set(0, R_ORBITA - 70, 95);
        } else {
            this.controls.target.set(0, 0, 0);
            this.camera.position.set(0, -170, 230);
        }
        this.controls.update();
    }

    // ------------------------------------------------------------------ charts
    initCharts() {
        const ChartJS = window.Chart;
        this.charts = {};
        if (typeof ChartJS !== 'function') {
            this.altNote.textContent = 'Chart.js não carregou.';
            return;
        }
        const base = (titleY, refs) => ({
            type: 'line',
            data: { datasets: [] },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'nearest', intersect: false },
                plugins: {
                    legend: { labels: { color: '#b9c8cc', boxWidth: 12, font: { size: 10 },
                        filter: (item) => !item.text.startsWith('limite') || item.text === refs.legend } },
                    tooltip: { callbacks: { title: (items) => `T+ ${items[0].parsed.x.toFixed(2)} h` } }
                },
                scales: {
                    x: { type: 'linear', min: 0, max: 1,
                         title: { display: true, text: this.axisTitle(), color: '#73858c', font: { size: 10 } },
                         ticks: { color: '#73858c' }, grid: { color: '#21313a' } },
                    y: { suggestedMin: refs.min, suggestedMax: refs.max,
                         title: { display: true, text: titleY, color: '#73858c', font: { size: 10 } },
                         ticks: { color: '#73858c' }, grid: { color: '#21313a' } }
                }
            }
        });
        this.charts.dist = new ChartJS(this.distCanvas, base('distância até a Gabriella [km]', { min: 950, max: 2050, legend: 'limite 1000 / 2000 km' }));
        this.charts.alt = new ChartJS(this.altCanvas, base('altitude [km]', { min: 280, max: 470, legend: 'limite 300 / 450 km' }));
    }

    escalaTexto() {
        const minutosPorSegundo = 60 / this.segundosPorHora;
        return minutosPorSegundo >= 60
            ? `${minutosPorSegundo / 60} h = 1 s`
            : `${Math.round(minutosPorSegundo)} min = 1 s`;
    }

    axisTitle() {
        return `tempo de missão [h]  (${this.escalaTexto()})`;
    }

    updateAxisTitles() {
        for (const chart of Object.values(this.charts || {})) {
            chart.options.scales.x.title.text = this.axisTitle();
            chart.update('none');
        }
    }

    refLine(label, y, dur, color, dash = [6, 4]) {
        return { label, data: [{ x: 0, y }, { x: dur, y }], borderColor: color, borderDash: dash,
                 borderWidth: 1.5, pointRadius: 0, fill: false };
    }

    loadCharts() {
        if (!this.charts.dist) return;
        const dur = this.sim.duracaoH;
        const dtH = this.sim.dtAmostraS / 3600;
        this.series = {};
        const distSets = [];
        const altSets = [];
        for (const [nome, s] of Object.entries(this.sim.satelites)) {
            const cor = CSS(CORES[nome]);
            this.series[nome] = {
                dist: s.dist.map((y, i) => ({ x: i * dtH, y })),
                alt: s.alt.map((y, i) => ({ x: i * dtH, y })),
            };
            const rotulo = `${nome}${s.manobra ? ` (${NOMES_ESTRATEGIA[s.estrategia.indice] || s.estrategia.nome})` : ''}`;
            distSets.push({ label: rotulo, data: [], borderColor: cor, backgroundColor: cor, borderWidth: 2, pointRadius: 0, satKey: nome });
            if (s.manobra) {
                altSets.push({ label: rotulo, data: [], borderColor: cor, backgroundColor: cor, borderWidth: 2, pointRadius: 0, satKey: nome });
            }
        }
        const c = this.sim.constantes;
        distSets.push(
            this.refLine('limite 1000 / 2000 km', LIMITES_DIST[1], dur, '#ff6670'),
            this.refLine('limite 1000 km', LIMITES_DIST[0], dur, '#ff6670'),
            this.refLine('alvo 1500 km', c.dAlvo, dur, 'rgba(34,197,94,.6)', [2, 4])
        );
        altSets.push(
            this.refLine('limite 300 / 450 km', LIMITES_ALT[1], dur, '#ff6670'),
            this.refLine('limite 300 km', LIMITES_ALT[0], dur, '#ff6670'),
            this.refLine('alvo 400 km', c.hRef, dur, 'rgba(34,197,94,.6)', [2, 4])
        );
        for (const [chart, sets] of [[this.charts.dist, distSets], [this.charts.alt, altSets]]) {
            chart.data.datasets = sets;
            chart.options.scales.x.max = dur;
            chart.update('none');
        }
        this.altNote.textContent = altSets.length > 3 ? '' : 'Nenhum satélite em manobra: altitude constante.';
        this.updateCharts(0, true);
    }

    updateCharts(idx, force = false) {
        if (!this.series || !this.charts.dist) return;
        const now = performance.now();
        if (!force && now - this.lastChartUpdate < 100) return;
        this.lastChartUpdate = now;
        for (const [chart, key] of [[this.charts.dist, 'dist'], [this.charts.alt, 'alt']]) {
            for (const ds of chart.data.datasets) {
                if (ds.satKey) ds.data = this.series[ds.satKey][key].slice(0, idx + 1);
            }
            chart.update('none');
        }
    }

    // --------------------------------------------------------------- animação
    togglePlay() {
        if (!this.sim) return;
        if (this.simH >= this.sim.duracaoH) this.simH = 0;
        this.playing = !this.playing;
    }

    loop(ts) {
        if (!this.isRunning) return;
        requestAnimationFrame(this.loop);
        const dtReal = this.lastTs == null ? 0 : Math.min((ts - this.lastTs) / 1000, 0.1);
        this.lastTs = ts;
        if (this.sim && this.playing) {
            this.simH += dtReal / this.segundosPorHora;
            if (this.simH >= this.sim.duracaoH) {
                this.simH = this.sim.duracaoH;
                this.playing = false;
            }
            this.renderFrame();
        }
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.updateLabels();
        this.toolbar.querySelector('[data-action="play"]').textContent = this.playing ? '⏸' : '▶';
    }

    renderFrame() {
        if (!this.sim) return;
        const c = this.sim.constantes;
        const tSeg = this.simH * 3600;
        const n = this.sim.nPontos;
        const idxF = Math.min(tSeg / this.sim.dtAmostraS, n - 1);
        const i0 = Math.floor(idxF);
        const i1 = Math.min(i0 + 1, n - 1);
        const f = idxF - i0;

        this.objects.Gabriella.mesh.position.copy(this.polar(c.rRef, c.nRef * tSeg, tSeg));

        const linhas = [];
        for (const [nome, obj] of Object.entries(this.objects)) {
            if (!obj.data) continue;
            const p0 = obj.polares[i0];
            const p1 = obj.polares[i1];
            const th = p0.th + f * normalizaAngulo(p1.th - p0.th);
            obj.mesh.position.copy(this.polar(p0.r + f * (p1.r - p0.r), th, tSeg));
            obj.slot.position.copy(this.polar(c.rRef, c.nRef * tSeg + obj.data.phiAlvo, tSeg));
            if (obj.trail) obj.trail.geometry.setDrawRange(0, i0 + 1);

            if (obj.data.manobra) {
                const itens = obj.data.impulsos.map((imp, k) => {
                    const feito = this.simH >= imp.tH;
                    return `<li class="${feito ? 'done' : ''}">${feito ? '✓' : '·'} ${k + 1}: T+ ${imp.tH.toFixed(2)} h · ΔV ${imp.dv.toFixed(1)} m/s</li>`;
                }).join('');
                linhas.push(`<div><b style="color:${CSS(CORES[nome])}">${esc(nome)}</b> · ${esc(obj.data.estrategia.nome)}
                    · ${obj.data.dist[i0].toFixed(0)} km · ${obj.data.alt[i0].toFixed(1)} km alt<ul>${itens}</ul></div>`);
            } else {
                linhas.push(`<div><b style="color:${CSS(CORES[nome])}">${esc(nome)}</b> · sem manobra · ${obj.data.dist[i0].toFixed(0)} km</div>`);
            }
        }
        this.burnList.innerHTML = linhas.join('');
        this.toolbar.querySelector('[data-role="clock"]').textContent =
            `T+ ${this.simH.toFixed(2).replace('.', ',')} h / ${this.sim.duracaoH.toFixed(2).replace('.', ',')} h`;
        this.updateCharts(i0, !this.playing);
    }

    updateLabels() {
        const w = this.view.clientWidth;
        const h = this.view.clientHeight;
        for (const obj of Object.values(this.objects)) {
            const v = obj.mesh.position.clone().project(this.camera);
            const visible = v.z < 1 && Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1;
            obj.label.style.display = visible ? 'block' : 'none';
            obj.label.style.transform = `translate(${((v.x + 1) / 2) * w + 8}px, ${((1 - v.y) / 2) * h - 8}px)`;
        }
    }

    observeResize() {
        this.resizeObserver = new ResizeObserver(() => {
            const w = this.view.clientWidth;
            const h = this.view.clientHeight;
            if (!w || !h) return;
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
        });
        this.resizeObserver.observe(this.view);
    }

    serialize() {
        return null;
    }

    cleanup() {
        if (!this.isRunning) return;
        this.isRunning = false;
        this.resizeObserver?.disconnect();
        this.clearDynamic();
        Object.values(this.charts || {}).forEach((chart) => chart.destroy());
        this.renderer.dispose();
        super.cleanup();
        if (typeof this.deps.onClose === 'function') this.deps.onClose(this);
    }
}

export default SimulationWidget;
