import BaseWidget from "./BaseWidget.js";

export default class chartWidget extends BaseWidget {
    constructor(title, idContainerDestino, data) {
        super(title, idContainerDestino);

        this.data = data;            // referência a current_data (atualizada in-place pelo main.js)
        this.maxPoints = 100;        // quantos pontos ficam visíveis no buffer
        this.buffers = {};           // { chave: [valor, valor, ...] } -- histórico por dado
        this.selectedKey = null;     // chave atualmente plotada
        this.knownKeys = new Set();  // chaves já adicionadas ao <select>
        this.lineColor = '#d03379';  // cor da linha (alterável pelo usuário)
        this.paused = false;         // quando true, ignora dados novos

        // o conteúdo precisa preencher o espaço abaixo do header
        this.content.style.flex = '1';
        this.content.style.minHeight = '0';
        this.content.style.padding = '6px';
        this.content.style.gap = '6px';

        this.buildUI();
        this.setupCanvas();

        // limpeza: ao fechar o widget, para de observar o redimensionamento
        this.closeWidget.addEventListener('click', () => {
            if (this.resizeObserver) this.resizeObserver.disconnect();
        });
    }

    // Monta a barra de configuração (seletor + leitura) e a área do gráfico
    buildUI() {
        this.configBar = document.createElement('div');
        this.configBar.style.display = 'flex';
        this.configBar.style.alignItems = 'center';
        this.configBar.style.justifyContent = 'space-between';
        this.configBar.style.gap = '8px';
        this.configBar.style.flexShrink = '0';
        this.configBar.style.flexWrap = 'wrap'; // quebra linha se o widget estiver estreito

        // seletor de qual dado plotar
        this.select = document.createElement('select');
        this.select.style.backgroundColor = '#1f2937';
        this.select.style.color = '#e0e6ed';
        this.select.style.border = '1px solid #374151';
        this.select.style.borderRadius = '4px';
        this.select.style.padding = '3px 6px';
        this.select.style.fontFamily = 'inherit';
        this.select.style.fontSize = '0.8rem';
        this.select.style.cursor = 'pointer';
        this.select.addEventListener('mousedown', (e) => e.stopPropagation());
        this.select.addEventListener('change', () => {
            this.selectedKey = this.select.value;
            this.draw();
        });

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.innerText = 'aguardando dados...';
        this.select.appendChild(placeholder);

        // botão pausar / retomar o recebimento de dados
        this.pauseBtn = this.makeButton('Pausar');
        this.pauseBtn.addEventListener('click', () => {
            this.paused = !this.paused;
            this.pauseBtn.innerText = this.paused ? 'Retomar' : 'Pausar';
            // realça o botão enquanto está pausado
            this.pauseBtn.style.backgroundColor = this.paused ? '#374151' : '#1f2937';
        });

        // botão reset: limpa o histórico de todos os dados
        this.resetBtn = this.makeButton('Reset');
        this.resetBtn.addEventListener('click', () => {
            this.buffers = {};
            this.draw();
        });

        // seletor de cor da linha
        this.colorInput = document.createElement('input');
        this.colorInput.type = 'color';
        this.colorInput.value = this.lineColor;
        this.colorInput.title = 'Cor da linha';
        this.colorInput.style.width = '34px';
        this.colorInput.style.height = '26px';
        this.colorInput.style.padding = '0';
        this.colorInput.style.border = '1px solid #374151';
        this.colorInput.style.borderRadius = '4px';
        this.colorInput.style.backgroundColor = '#1f2937';
        this.colorInput.style.cursor = 'pointer';
        this.colorInput.addEventListener('mousedown', (e) => e.stopPropagation());
        this.colorInput.addEventListener('input', () => {
            this.lineColor = this.colorInput.value;
            this.draw();
        });

        // leitura do valor atual
        this.readout = document.createElement('span');
        this.readout.style.fontSize = '0.85rem';
        this.readout.style.color = this.lineColor;
        this.readout.style.fontWeight = 'bold';
        this.readout.style.marginLeft = 'auto'; // empurra a leitura para a direita
        this.readout.innerText = '--';

        // grupo da esquerda: seletor + controles
        const controls = document.createElement('div');
        controls.style.display = 'flex';
        controls.style.alignItems = 'center';
        controls.style.gap = '6px';
        controls.style.flexWrap = 'wrap';
        controls.appendChild(this.select);
        controls.appendChild(this.pauseBtn);
        controls.appendChild(this.resetBtn);
        controls.appendChild(this.colorInput);

        this.configBar.appendChild(controls);
        this.configBar.appendChild(this.readout);

        // wrapper do canvas (ocupa o espaço restante)
        this.canvasWrapper = document.createElement('div');
        this.canvasWrapper.style.position = 'relative';
        this.canvasWrapper.style.flex = '1';
        this.canvasWrapper.style.minHeight = '0';

        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.inset = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvasWrapper.appendChild(this.canvas);

        this.content.appendChild(this.configBar);
        this.content.appendChild(this.canvasWrapper);

        this.ctx = this.canvas.getContext('2d');
    }

    // Cria um botão de controle com o estilo do tema
    makeButton(label) {
        const btn = document.createElement('button');
        btn.innerText = label;
        btn.style.backgroundColor = '#1f2937';
        btn.style.color = '#e0e6ed';
        btn.style.border = '1px solid #374151';
        btn.style.borderRadius = '4px';
        btn.style.padding = '4px 8px';
        btn.style.fontFamily = 'inherit';
        btn.style.fontSize = '0.75rem';
        btn.style.cursor = 'pointer';
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        return btn;
    }

    // Observa o redimensionamento do widget para redesenhar o gráfico
    setupCanvas() {
        this.resizeObserver = new ResizeObserver(() => {
            this.fitCanvas();
            this.draw();
        });
        this.resizeObserver.observe(this.canvasWrapper);
        this.fitCanvas();
    }

    // Ajusta a resolução do canvas ao tamanho real (com correção de DPI)
    fitCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const w = this.canvasWrapper.clientWidth;
        const h = this.canvasWrapper.clientHeight;
        if (w === 0 || h === 0) return; // ainda não está no DOM / sem layout
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // desenhar em coordenadas CSS
        this.cssW = w;
        this.cssH = h;
    }

    // Adiciona ao <select> qualquer chave numérica nova que apareça nos dados
    refreshKeys() {
        if (this.data == undefined) return;
        for (const [key, value] of Object.entries(this.data)) {
            if (!Number.isFinite(parseFloat(value))) continue; // ignora chaves não-numéricas
            if (this.knownKeys.has(key)) continue;

            this.knownKeys.add(key);
            const opt = document.createElement('option');
            opt.value = key;
            opt.innerText = key;

            // remove o placeholder na primeira chave válida
            if (this.select.options.length === 1 && this.select.options[0].value === '') {
                this.select.remove(0);
            }
            this.select.appendChild(opt);

            // seleciona a primeira chave automaticamente
            if (this.selectedKey === null) {
                this.selectedKey = key;
                this.select.value = key;
            }
        }
    }

    // Chamado pelo main.js a cada evento 'new_data'
    update(deltaTime) {
        if (this.data == undefined) return;
        if (this.paused) return; // pausado: não recebe dados novos
        this.refreshKeys();

        // guarda o valor de cada chave numérica no respectivo buffer
        for (const [key, value] of Object.entries(this.data)) {
            const num = parseFloat(value);
            if (!Number.isFinite(num)) continue;
            if (!this.buffers[key]) this.buffers[key] = [];
            const buf = this.buffers[key];
            buf.push(num);
            if (buf.length > this.maxPoints) buf.shift();
        }

        this.draw();
    }

    // Desenha o gráfico de linha do dado selecionado
    draw() {
        if (!this.ctx || !this.cssW) return;
        const ctx = this.ctx;
        const W = this.cssW;
        const H = this.cssH;

        ctx.clearRect(0, 0, W, H);

        const buf = this.selectedKey ? this.buffers[this.selectedKey] : null;

        if (!buf || buf.length === 0) {
            this.readout.innerText = '--';
            ctx.fillStyle = '#9ca3af';
            ctx.font = '12px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('sem dados para "' + (this.selectedKey || '') + '"', W / 2, H / 2);
            return;
        }

        // margens para os eixos
        const mL = 44, mR = 10, mT = 10, mB = 18;
        const plotW = W - mL - mR;
        const plotH = H - mT - mB;
        if (plotW <= 0 || plotH <= 0) return;

        // escala Y automática, com 10% de folga
        let min = Math.min(...buf);
        let max = Math.max(...buf);
        if (min === max) { min -= 1; max += 1; } // evita divisão por zero quando o valor é constante
        const pad = (max - min) * 0.1;
        min -= pad; max += pad;

        const xFor = (i) => mL + (buf.length === 1 ? plotW / 2 : (i / (buf.length - 1)) * plotW);
        const yFor = (v) => mT + plotH - ((v - min) / (max - min)) * plotH;

        // grade horizontal + rótulos do eixo Y
        ctx.strokeStyle = '#374151';
        ctx.fillStyle = '#9ca3af';
        ctx.lineWidth = 1;
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const ticks = 4;
        for (let i = 0; i <= ticks; i++) {
            const v = min + (i / ticks) * (max - min);
            const y = yFor(v);
            ctx.beginPath();
            ctx.moveTo(mL, y);
            ctx.lineTo(W - mR, y);
            ctx.stroke();
            ctx.fillText(v.toFixed(1), mL - 6, y);
        }

        // linha do dado
        ctx.strokeStyle = this.lineColor;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        buf.forEach((v, i) => {
            const x = xFor(i);
            const y = yFor(v);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // ponto final destacado
        const lx = xFor(buf.length - 1);
        const ly = yFor(buf[buf.length - 1]);
        ctx.fillStyle = this.lineColor;
        ctx.beginPath();
        ctx.arc(lx, ly, 3, 0, Math.PI * 2);
        ctx.fill();

        // atualiza a leitura do valor atual
        this.readout.style.color = this.lineColor;
        this.readout.innerText = buf[buf.length - 1].toFixed(2);
    }
}