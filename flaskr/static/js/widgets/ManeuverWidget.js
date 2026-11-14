import BaseWidget from './BaseWidget.js';
import { registerWidgetType } from './WidgetRegistry.js';

const ROTULOS_ESTRATEGIA = ['1', '2', '3'];

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function num(value, casas = 0) {
    return Number.isFinite(value) ? value.toFixed(casas) : '--';
}

function hora(iso) {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime())
        ? date.toLocaleTimeString('pt-BR', { hour12: false })
        : '--:--:--';
}

/**
 * Painel de decisão de manobras da Missão 2.
 * Recebe o evento 'manobra' do backend (uwb.py -> analisar_manobras.py) e mostra,
 * para Beatriz e Carolina, a distância até a Gabriella na banda de controle, o
 * status NOMINAL/CORRIGIR e as estratégias (1) 1º cruzamento, (2) 2º cruzamento e
 * (3) faseamento.
 */
class ManeuverWidget extends BaseWidget {
    static widgetType = 'manobras';

    constructor(title, idContainerDestino) {
        super(title, idContainerDestino);
        this.element.style.width = '520px';
        this.element.style.height = '600px';
        this.element.classList.add('maneuver-widget');

        this.payload = null;
        this.status = null;
        this.requestManeuver = null;
        this.openDetails = new Set();

        this.toolbar = document.createElement('div');
        this.toolbar.className = 'mnv-toolbar';
        this.toolbar.innerHTML = `
            <span class="mnv-source" data-role="source">AGUARDANDO GS</span>
            <span class="mnv-clock" data-role="clock">avaliação --:--:--</span>
            <span class="mnv-spacer"></span>
            <button type="button" class="mnv-btn" data-action="recalc" title="Avalia agora com as medidas atuais">AVALIAR</button>
            <button type="button" class="mnv-btn mnv-btn-force" data-action="force" title="Calcula as 3 estratégias mesmo se estiver nominal">FORÇAR</button>
        `;
        this.message = document.createElement('div');
        this.message.className = 'mnv-message';

        this.body = document.createElement('div');
        this.body.className = 'mnv-body';
        this.body.innerHTML = `<p class="mnv-empty">Aguardando a primeira avaliação (a cada 5 s)...</p>`;

        this.content.append(this.toolbar, this.message, this.body);

        this.toolbar.addEventListener('mousedown', (e) => e.stopPropagation());
        this.toolbar.addEventListener('click', (e) => {
            const action = e.target.closest('button')?.dataset.action;
            if (action) this.request(action === 'force');
        });
        // Guarda quais <details> estão abertos para não fechá-los a cada atualização.
        this.body.addEventListener('toggle', (e) => {
            const key = e.target.dataset?.key;
            if (!key) return;
            if (e.target.open) this.openDetails.add(key);
            else this.openDetails.delete(key);
        }, true);
    }

    setManeuverRequester(fn) {
        this.requestManeuver = fn;
    }

    request(forcar) {
        if (typeof this.requestManeuver !== 'function') {
            this.setMessage('Sem conexão com o backend.', 'error');
            return;
        }
        const buttons = this.toolbar.querySelectorAll('button');
        buttons.forEach((b) => { b.disabled = true; });
        this.setMessage(forcar ? 'Calculando as 3 estratégias...' : 'Avaliando...', 'info');
        this.requestManeuver(forcar, (response) => {
            buttons.forEach((b) => { b.disabled = false; });
            this.setMessage(response?.message || 'Sem resposta.', response?.ok ? 'ok' : 'error');
        });
    }

    setMessage(text, kind = 'info') {
        this.message.textContent = text || '';
        this.message.dataset.kind = kind;
    }

    updateUwbStatus(status) {
        this.status = status;
        const source = this.toolbar.querySelector('[data-role="source"]');
        if (!status) return;
        const label = status.fonte === 'serial'
            ? `SERIAL ${status.porta || ''}`
            : status.fonte === 'simulado' ? 'SIMULADO' : 'UWB OFF';
        source.textContent = label;
        source.dataset.state = status.conectado ? 'on' : 'off';
        source.title = status.mensagem || '';
        if (status.mensagem && (!this.message.textContent || this.message.dataset.kind === 'status')) {
            this.setMessage(status.mensagem, 'status');
        }
    }

    updateManeuver(payload) {
        if (!payload?.satelites) return;
        this.payload = payload;
        this.toolbar.querySelector('[data-role="clock"]').textContent =
            `avaliação ${hora(payload.timestamp)}${payload.forcado ? ' (forçada)' : ''}`;
        if (payload.fonte) this.updateUwbStatus(payload.fonte);
        this.render_();
    }

    render_() {
        const p = this.payload;
        if (!p) return;
        const cfg = p.config || {};
        const cards = Object.values(p.satelites).map((sat) => this.satCard(sat, cfg)).join('');
        this.body.innerHTML = cards + this.pairsTable(p) + `
            <p class="mnv-foot">
                Alvo ${num(cfg.alvoKm)} km ± ${num(cfg.bandaKm)} km a ${num(cfg.hRefKm)} km (±${num(cfg.tolAltKm)} km) ·
                escala ${num(cfg.escalaKmPorM)} km/m · altitude ${esc(cfg.altFonte)} ·
                ${p.medidasDesdeUltima ?? 0} medidas desde a última avaliação
            </p>`;
        this.body.querySelectorAll('details[data-key]').forEach((d) => {
            if (this.openDetails.has(d.dataset.key)) d.open = true;
        });
    }

    bandBar(sat, cfg) {
        const [min, max] = cfg.envelopeKm || [1000, 2000];
        const span = max - min;
        const pct = (v) => Math.max(0, Math.min(100, ((v - min) / span) * 100));
        const lo = pct(cfg.alvoKm - cfg.bandaKm);
        const hi = pct(cfg.alvoKm + cfg.bandaKm);
        const marker = Number.isFinite(sat.dKm)
            ? `<span class="mnv-band-marker" style="left:${pct(sat.dKm)}%"></span>` : '';
        return `
            <div class="mnv-band" title="Banda de controle: ${num(cfg.alvoKm - cfg.bandaKm)}–${num(cfg.alvoKm + cfg.bandaKm)} km">
                <span class="mnv-band-ok" style="left:${lo}%;width:${hi - lo}%"></span>
                <span class="mnv-band-target" style="left:${pct(cfg.alvoKm)}%"></span>
                ${marker}
            </div>
            <div class="mnv-band-scale"><span>${min}</span><span>${num(cfg.alvoKm)} km</span><span>${max}</span></div>`;
    }

    satCard(sat, cfg) {
        const status = sat.status || 'SEM DADOS';
        const statusClass = status === 'NOMINAL' ? 'ok' : status === 'CORRIGIR' ? 'alert' : 'idle';
        const hasData = Number.isFinite(sat.dKm);
        const metrics = hasData ? `
            <div class="mnv-metrics">
                <span><b>d</b> ${num(sat.dKm)} km <small>(${num(sat.dM, 3)} m)</small></span>
                <span><b>h</b> ${num(sat.hKm)} km <small>(${esc(sat.altFonte)})</small></span>
                <span><b>N</b> ${sat.n ?? '--'}</span>
                <span><b>idade</b> ${num(sat.idadeS, 1)} s</span>
            </div>` : `<p class="mnv-muted">${esc(sat.info || 'Sem medidas.')}</p>`;
        const motivos = (sat.motivos || []).map((m) => `<li>${esc(m)}</li>`).join('');

        let strategies = '';
        if (Array.isArray(sat.estrategias) && sat.estrategias.length) {
            const note = sat.reaproveitada
                ? `<p class="mnv-muted">Estado igual ao da última análise (${hora(sat.calculadaEm)}): a manobra anterior continua válida.</p>`
                : '';
            strategies = note + sat.estrategias.map((e, i) => this.strategyRow(sat, e, i)).join('');
        } else if (status === 'NOMINAL') {
            strategies = `<p class="mnv-muted">Dentro da banda de controle: nenhuma manobra.</p>`;
        }

        return `
            <section class="mnv-card" data-status="${statusClass}">
                <div class="mnv-card-head">
                    <strong>${esc(sat.nome)}</strong>
                    <span class="mnv-muted">${esc(sat.lado)} da Gabriella</span>
                    <span class="mnv-spacer"></span>
                    ${sat.velho ? '<span class="mnv-badge mnv-badge-stale">DADO VELHO</span>' : ''}
                    <span class="mnv-badge mnv-badge-${statusClass}">${esc(status)}</span>
                </div>
                ${hasData ? this.bandBar(sat, cfg) : ''}
                ${metrics}
                ${motivos ? `<ul class="mnv-reasons">${motivos}</ul>` : ''}
                ${strategies}
            </section>`;
    }

    strategyRow(sat, e, i) {
        const best = sat.melhor === i;
        const key = `${sat.nome}-${i}`;
        const head = `
            <span class="mnv-strat-id">(${ROTULOS_ESTRATEGIA[i] ?? i + 1})</span>
            <span class="mnv-strat-name">${esc(e.nome)}</span>
            <span class="mnv-spacer"></span>
            ${e.viavel
                ? `<span class="mnv-strat-dv">ΔV ${num(e.dvTotal, 1)} m/s</span>
                   <span class="mnv-strat-time">${num(e.duracaoMin, 1)} min</span>
                   ${best ? '<span class="mnv-badge mnv-badge-best">MENOR ΔV</span>' : ''}`
                : '<span class="mnv-badge mnv-badge-idle">NÃO VIÁVEL</span>'}`;
        if (!e.viavel) {
            return `<div class="mnv-strat mnv-strat-off"><div class="mnv-strat-head">${head}</div>
                    <p class="mnv-muted mnv-strat-reason">${esc(e.motivo)}</p></div>`;
        }
        const impulses = (e.impulsos || []).map((imp, k) => `
            <tr><td>${k + 1}</td><td>${num(imp.tMin, 1)} min</td><td>${num(imp.dv, 1)} m/s</td><td>${esc(imp.desc)}</td></tr>`).join('');
        const m = e.medidas || {};
        const d = e.detalhe || {};
        const extra = Number.isFinite(d.hFase)
            ? `órbita de espera a ${num(d.hFase)} km por ${num(d.tEsperaMin, 1)} min (deriva ${num(d.derivaKmH)} km/h)`
            : Number.isFinite(d.apogeu) ? `elipse: perigeu ${num(d.perigeu)} km, apogeu ${num(d.apogeu)} km` : '';
        const alt = e.alternativa
            ? `<p class="mnv-muted">Alternativa mais rápida: espera a ${num(e.alternativa.hFase)} km, ${num(e.alternativa.dvTotal, 1)} m/s em ${num(e.alternativa.duracaoMin)} min.</p>`
            : '';
        return `
            <details class="mnv-strat${best ? ' mnv-strat-best' : ''}" data-key="${esc(key)}">
                <summary class="mnv-strat-head">${head}</summary>
                <table class="mnv-table">
                    <thead><tr><th>#</th><th>t</th><th>ΔV</th><th>impulso</th></tr></thead>
                    <tbody>${impulses}</tbody>
                </table>
                ${extra ? `<p class="mnv-muted">${esc(extra)}</p>` : ''}
                <p class="mnv-muted">Durante a manobra: altitude ${num(m.altMin)}–${num(m.altMax)} km ·
                    distância ${num(m.dMin)}–${num(m.dMax)} km · final ${num(m.dFinal, 1)} km em ${num(m.altFinal, 1)} km ·
                    ΔV RK4 ${num(m.dvRk4, 1)} m/s</p>
                ${alt}
            </details>`;
    }

    pairsTable(p) {
        const rows = (p.pares || []).map((r) => `
            <tr${r.idadeS != null && r.idadeS > (p.config?.idadeMaxS ?? 30) ? ' class="mnv-stale"' : ''}>
                <td>${esc(r.par)}</td><td>${esc(r.nomes)}</td>
                <td>${r.mediaM == null ? '---' : num(r.mediaM, 3)}</td>
                <td>${r.n}</td><td>${r.idadeS == null ? '---' : num(r.idadeS, 1)}</td>
            </tr>`).join('');
        return `
            <details class="mnv-pairs" data-key="pares">
                <summary>Medidas por par (média móvel)</summary>
                <table class="mnv-table">
                    <thead><tr><th>par</th><th>placas</th><th>média [m]</th><th>N</th><th>idade [s]</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </details>`;
    }

    clearData() {
        super.clearData();
    }
}

registerWidgetType('manobras', ManeuverWidget, 'Manobras');

export default ManeuverWidget;
