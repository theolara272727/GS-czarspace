import BaseWidget from "./BaseWidget.js";

const Chart = window.Chart;

export default class ChartLineWidget extends BaseWidget {
    constructor(title, idContainerDestino) {
        super(title, idContainerDestino);

        this.maxPoints = 40;         
        this.buffers = {};           
        this.knownKeys = new Set();  
        this.paused = false;         

        // 1. O novo estado de multilinhas e a paleta de cores automática
        this.activeKeys = []; // Estrutura: [ { key: 'Temperatura', color: '#...' }, ... ]
        this.palette = [
            '#d03379', // Rosa
            '#33d08a', // Verde
            '#3379d0', // Azul
            '#d08a33', // Laranja
            '#a333d0', // Roxo
            '#33d0d0', // Ciano
            '#d0d033'  // Amarelo
        ];

        this.content.style.flex = '1';
        this.content.style.minHeight = '0';
        this.content.style.padding = '6px';
        this.content.style.gap = '6px';
        this.content.style.display = 'flex';
        this.content.style.flexDirection = 'column';

        this.buildUI();
        this.setupCanvas();

        this.closeWidget.addEventListener('click', () => {
            if (this.resizeObserver) this.resizeObserver.disconnect();
            if (this.chart) this.chart.destroy();
        });
    }

    buildUI() {
        this.configBar = document.createElement('div');
        this.configBar.style.display = 'flex';
        this.configBar.style.flexDirection = 'column';
        this.configBar.style.gap = '8px';
        this.configBar.style.flexShrink = '0';

        // Linha 1: Controles Principais
        const controlsRow = document.createElement('div');
        controlsRow.style.display = 'flex';
        controlsRow.style.alignItems = 'center';
        controlsRow.style.gap = '6px';
        controlsRow.style.flexWrap = 'wrap';

        // O Seletor agora age como um botão de "Adicionar"
        this.select = document.createElement('select');
        this.select.style.backgroundColor = '#1f2937';
        this.select.style.color = '#e0e6ed';
        this.select.style.border = '1px solid #374151';
        this.select.style.borderRadius = '4px';
        this.select.style.padding = '3px 6px';
        this.select.style.fontFamily = 'inherit';
        this.select.style.fontSize = '0.8rem';
        this.select.style.cursor = 'pointer';
        
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.innerText = '+ Adicionar Dado...';
        this.select.appendChild(placeholder);

        this.select.addEventListener('mousedown', (e) => e.stopPropagation());
        
        // 2. Lógica para adicionar uma nova linha
        this.select.addEventListener('change', () => {
            const selectedVal = this.select.value;
            
            // Verifica se escolheu algo válido e se já não está ativo
            if (selectedVal && !this.activeKeys.find(k => k.key === selectedVal)) {
                // Pega a próxima cor da paleta baseado na quantidade de linhas
                const nextColor = this.palette[this.activeKeys.length % this.palette.length];
                
                this.activeKeys.push({ key: selectedVal, color: nextColor });
                this.renderChips();
                this.draw();
            }
            
            // Volta o select para o placeholder
            this.select.value = '';
        });

        this.pauseBtn = this.makeButton('Pausar');
        this.pauseBtn.addEventListener('click', () => {
            this.paused = !this.paused;
            this.pauseBtn.innerText = this.paused ? 'Retomar' : 'Pausar';
            this.pauseBtn.style.backgroundColor = this.paused ? '#374151' : '#1f2937';
        });

        this.resetBtn = this.makeButton('Reset');
        this.resetBtn.addEventListener('click', () => {
            this.buffers = {};
            this.draw();
        });

        controlsRow.appendChild(this.select);
        controlsRow.appendChild(this.pauseBtn);
        controlsRow.appendChild(this.resetBtn);

        // Linha 2: Os "Chips" (Etiquetas das linhas ativas)
        this.chipsRow = document.createElement('div');
        this.chipsRow.style.display = 'flex';
        this.chipsRow.style.flexWrap = 'wrap';
        this.chipsRow.style.gap = '6px';

        this.configBar.appendChild(controlsRow);
        this.configBar.appendChild(this.chipsRow);

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
    }

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

    // 3. Desenha as etiquetas para o usuário saber quais linhas estão ativas
    renderChips() {
        this.chipsRow.innerHTML = ''; // Limpa a linha
        
        this.activeKeys.forEach((item, index) => {
            const chip = document.createElement('div');
            chip.style.display = 'flex';
            chip.style.alignItems = 'center';
            chip.style.backgroundColor = '#374151';
            chip.style.padding = '2px 8px';
            chip.style.borderRadius = '12px';
            chip.style.fontSize = '0.75rem';
            chip.style.color = '#e0e6ed';
            chip.style.gap = '6px';

            // Bolinha colorida
            const colorDot = document.createElement('div');
            colorDot.style.width = '10px';
            colorDot.style.height = '10px';
            colorDot.style.borderRadius = '50%';
            colorDot.style.backgroundColor = item.color;

            // Texto do dado
            const label = document.createElement('span');
            label.innerText = item.key;

            // Botão de remover (X)
            const closeBtn = document.createElement('span');
            closeBtn.innerText = '×';
            closeBtn.style.cursor = 'pointer';
            closeBtn.style.color = '#9ca3af';
            closeBtn.style.fontWeight = 'bold';
            closeBtn.style.fontSize = '1rem';
            closeBtn.style.lineHeight = '1';
            
            closeBtn.addEventListener('click', () => {
                // Remove do array e manda redesenhar
                this.activeKeys.splice(index, 1);
                this.renderChips();
                this.draw();
            });

            chip.appendChild(colorDot);
            chip.appendChild(label);
            chip.appendChild(closeBtn);
            
            this.chipsRow.appendChild(chip);
        });
    }

    setupCanvas() {
        this.ctx = this.canvas.getContext('2d');

        const noDataPlugin = {
            id: 'noDataText',
            afterDraw: (chart) => {
                // Se não houver datasets, mostra o aviso
                if (chart.data.datasets.length === 0) {
                    const ctx = chart.ctx;
                    chart.clear();
                    ctx.save();
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = '#9ca3af';
                    ctx.font = '12px monospace';
                    ctx.fillText('Nenhum dado selecionado', chart.width / 2, chart.height / 2);
                    ctx.restore();
                }
            }
        };

        this.chart = new Chart(this.ctx, {
            type: 'line',
            data: {
                labels: [], 
                datasets: [] // Começa vazio, os datasets serão injetados dinamicamente
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false, 
                layout: {
                    padding: { top: 10, bottom: 10, left: 10, right: 10 }
                },
                scales: {
                    x: {
                        grid: { color: '#374151', drawBorder: false },
                        ticks: { color: '#9ca3af', font: { family: 'monospace', size: 12 }, maxTicksLimit: 10 }
                    },
                    y: {
                        grid: { color: '#374151', drawBorder: false },
                        ticks: { color: '#9ca3af', font: { family: 'monospace', size: 10 }, maxTicksLimit: 5 },
                        border: { display: false }
                    }
                },
                plugins: {
                    // Ligamos a legenda oficial do Chart.js!
                    legend: { 
                        display: true,
                        labels: {
                            color: '#9ca3af',
                            font: { family: 'monospace' },
                            boxWidth: 12
                        }
                    },
                    tooltip: {
                        enabled: true,             
                        intersect: false,          
                        mode: 'index', // Isso é PERFEITO para múltiplas linhas, mostra todas juntas no hover!
                        backgroundColor: '#1f2937', 
                        titleColor: '#9ca3af',      
                        bodyColor: '#e0e6ed',       
                        borderColor: '#374151',     
                        borderWidth: 1,
                        font: { family: 'monospace' },
                        callbacks: {
                            title: function(context) { return 'Tempo: ' + context[0].label; },
                            label: function(context) { return context.dataset.label + ': ' + context.parsed.y.toFixed(2); }
                        }
                    }
                }
            },
            plugins: [noDataPlugin]
        });

        this.resizeObserver = new ResizeObserver(() => {
            if(this.chart) this.chart.resize();
        });
        this.resizeObserver.observe(this.canvasWrapper);
    }

    refreshKeys(sensores) {
        if (!sensores) return;
        
        for (const [key, value] of Object.entries(sensores)) {
            if (!Number.isFinite(parseFloat(value))) continue; 
            if (this.knownKeys.has(key)) continue;

            this.knownKeys.add(key);
            const opt = document.createElement('option');
            opt.value = key;
            opt.innerText = key;
            this.select.appendChild(opt);

            // Auto-seleciona a PRIMEIRA chave que o sistema descobrir (facilita pro usuário)
            if (this.activeKeys.length === 0 && !this.primeiraChaveAdicionada) {
                this.primeiraChaveAdicionada = true;
                this.activeKeys.push({ key: key, color: this.palette[0] });
                this.renderChips();
            }
        }
    }

    update(dados) {
        if (!dados || !dados.sensores) return;
        if (this.paused) return; 
        
        this.refreshKeys(dados.sensores);

        const agora = new Date();
        const timestampStr = `${agora.getHours().toString().padStart(2, '0')}:${agora.getMinutes().toString().padStart(2, '0')}:${agora.getSeconds().toString().padStart(2, '0')}.${Math.floor(agora.getMilliseconds() / 100)}`;

        for (const [key, value] of Object.entries(dados.sensores)) {
            const num = parseFloat(value);
            if (!Number.isFinite(num)) continue;
            if (!this.buffers[key]) this.buffers[key] = [];
            
            const buf = this.buffers[key];
            buf.push({ value: num, time: timestampStr });
            
            if (buf.length > this.maxPoints) buf.shift();
        }

        this.draw();
    }

    // 4. O novo motor de desenho para múltiplas linhas
    draw() {
        if (!this.chart) return;

        if (this.activeKeys.length === 0) {
            this.chart.data.labels = [];
            this.chart.data.datasets = [];
            this.chart.update();
            return;
        }

        // Pega as labels (Eixo X) baseadas na primeira linha ativa (já que os timestamps são os mesmos)
        const firstKey = this.activeKeys[0].key;
        const baseBuffer = this.buffers[firstKey];
        
        if (baseBuffer) {
            this.chart.data.labels = baseBuffer.map(item => item.time);
        }

        // Reconstrói a lista de linhas dinamicamente
        this.chart.data.datasets = this.activeKeys.map((item) => {
            const bufferDaLinha = this.buffers[item.key] || [];
            return {
                label: item.key,
                data: bufferDaLinha.map(d => d.value),
                borderColor: item.color,
                backgroundColor: item.color,
                borderWidth: 2,
                pointBackgroundColor: item.color,
                tension: 0 
            };
        });

        this.chart.update();
    }
}