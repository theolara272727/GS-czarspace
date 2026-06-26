import BaseWidget from "./BaseWidget.js";

const Chart = window.Chart;
// Lembre-se de garantir que o Chart.js está importado no seu projeto.
// Exemplo: import Chart from 'chart.js/auto'; (se estiver usando bundler)

export default class chartWidget extends BaseWidget {
    constructor(title, idContainerDestino, data) {
        super(title, idContainerDestino);

        this.data = data;                // referência a current_data (atualizada in-place pelo main.js)
        this.maxPoints = 40;        // quantos pontos ficam visíveis no buffer
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

        // limpeza: ao fechar o widget, desconecta o observer e destrói o gráfico
        this.closeWidget.addEventListener('click', () => {
            if (this.resizeObserver) this.resizeObserver.disconnect();
            if (this.chart) this.chart.destroy();
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

    // Instancia o Chart.js e observa redimensionamento
    setupCanvas() {
        this.ctx = this.canvas.getContext('2d');

        // Plugin interno para desenhar a mensagem "sem dados"
        const noDataPlugin = {
            id: 'noDataText',
            afterDraw: (chart) => {
                if (chart.data.datasets[0].data.length === 0) {
                    const ctx = chart.ctx;
                    const width = chart.width;
                    const height = chart.height;
                    
                    chart.clear();
                    ctx.save();
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = '#9ca3af';
                    ctx.font = '12px monospace';
                    ctx.fillText('sem dados para "' + (this.selectedKey || '') + '"', width / 2, height / 2);
                    ctx.restore();
                }
            }
        };

        this.chart = new Chart(this.ctx, {
            type: 'line',
            data: {
                labels: [], // Eixo X automático
                datasets: [{
                    label: 'Dado',
                    data: [],
                    borderColor: this.lineColor,
                    backgroundColor: this.lineColor,
                    borderWidth: 2,
                    pointBackgroundColor: this.lineColor,
                    tension: 0 
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false, // Desliga a animação para o gráfico fluir em tempo real (snappy)
                layout: {
                    padding: { top: 10, bottom: 10, left: 10, right: 10 }
                },
                scales: {
                    x: {
                        display: true, 
                        grid: {
                            color: '#374151',
                            drawBorder: false
                        },
                        ticks: {
                            display: true,       
                            color: '#9ca3af',
                            font: { family: 'monospace', size: 12 },

                            maxTicksLimit: 10    
                        }
                    },
                    y: {
                        grid: {
                            color: '#374151',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#9ca3af',
                            font: { family: 'monospace', size: 10 },
                            maxTicksLimit: 5
                        },
                        border: { display: false }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: true,             // Ativa o balão de texto
                        intersect: false,          // Mostra o balão mesmo se o mouse não estiver exatamente em cima do pontinho (melhora a usabilidade)
                        mode: 'index',             // Foca no ponto mais próximo do eixo X
                        backgroundColor: '#1f2937', // Fundo escuro combinando com o tema do widget
                        titleColor: '#9ca3af',      // Cor do título (Eixo X / Timestamp)
                        bodyColor: '#e0e6ed',       // Cor do texto do valor (Eixo Y)
                        borderColor: '#374151',     // Borda sutil
                        borderWidth: 1,
                        font: {
                            family: 'monospace'    // Mantém o padrão de fonte que você está usando
                        },
                        callbacks: {
                            // Customiza o título do balão (Eixo X)
                            title: function(context) {
                                return 'Tempo: ' + context[0].label;
                            },
                            // Customiza o texto principal do balão (Eixo Y)
                            label: function(context) {
                                // context.parsed.y pega o valor numérico puro do ponto atual
                                return 'Valor: ' + context.parsed.y.toFixed(2);
                            }
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

        const agora = new Date();
        const timestampStr = `${agora.getHours().toString().padStart(2, '0')}:${agora.getMinutes().toString().padStart(2, '0')}:${agora.getSeconds().toString().padStart(2, '0')}.${Math.floor(agora.getMilliseconds() / 100)}`;


        // guarda o valor de cada chave numérica no respectivo buffer
        for (const [key, value] of Object.entries(this.data)) {
            const num = parseFloat(value);
            if (!Number.isFinite(num)) continue;
            if (!this.buffers[key]) this.buffers[key] = [];
            const buf = this.buffers[key];
            buf.push({ value: num, time: timestampStr });
            if (buf.length > this.maxPoints) buf.shift();
        }

        this.draw();
    }

    // Atualiza o gráfico de linha do dado selecionado utilizando o Chart.js
    draw() {
        if (!this.chart) return;

        const buf = this.selectedKey ? this.buffers[this.selectedKey] : null;

        if (!buf || buf.length === 0) {
            this.readout.innerText = '--';
            this.chart.data.labels = [];
            this.chart.data.datasets[0].data = [];
            this.chart.update();
            return;
        }

        // Atualiza cores caso o usuário tenha alterado
        this.chart.data.datasets[0].borderColor = this.lineColor;
        this.chart.data.datasets[0].backgroundColor = this.lineColor;
        this.chart.data.datasets[0].pointBackgroundColor = this.lineColor;

        // Passa os dados e cria labels vazias/numeradas para o eixo X do Chart.js
        this.chart.data.labels = buf.map(item => item.time);   // Eixo X (Timestamps)
        this.chart.data.datasets[0].data = buf.map(item => item.value);


        // Solicita ao Chart.js que redesenhe a tela
        this.chart.update();

        // atualiza a leitura do valor atual na interface
        this.readout.style.color = this.lineColor;
        this.readout.innerText = buf[buf.length - 1]['value'].toFixed(2);
    }
}