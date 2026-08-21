import BaseWidget from "./BaseWidget.js";

const Chart = window.Chart;

export default class chartWidget extends BaseWidget {
    constructor(title, idContainerDestino, data) {
        super(title, idContainerDestino);

        this.data = data;
        this.maxPoints = 50; 
        this.buffers = {};
        this.selectedKey = null;
        this.knownKeys = new Set();
        this.lineColor = '#d03379';
        this.paused = false;

        this.content.style.flex = '1';
        this.content.style.minHeight = '0';
        this.content.style.padding = '6px';
        this.content.style.gap = '6px';

        this.buildUI();
        this.setupCanvas();

        this.closeWidget.addEventListener('click', () => {
            this.destroyChart();
        });
    }

    getKind() {
        return 'chart';
    }

    destroyChart() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }

    cleanup() {
        this.destroyChart();
        super.cleanup();
    }

    serialize() {
        return {
            ...super.serialize(),
            type: this.getKind(),
            selectedKey: this.selectedKey,
            lineColor: this.lineColor,
            paused: this.paused
        };
    }

    applyState(state = {}) {
        if (state.lineColor) {
            this.lineColor = state.lineColor;
            if (this.colorInput) {
                this.colorInput.value = state.lineColor;
            }
        }
        if (typeof state.paused === 'boolean') {
            this.paused = state.paused;
            if (this.pauseBtn) {
                this.pauseBtn.innerText = this.paused ? 'Retomar' : 'Pausar';
                this.pauseBtn.style.backgroundColor = this.paused ? '#374151' : '#1f2937';
            }
        }
        if (state.selectedKey) {
            this.selectedKey = state.selectedKey;
            if (this.select) {
                this.select.value = state.selectedKey;
            }
        }
    }

    buildUI() {
        this.configBar = document.createElement('div');
        this.configBar.style.display = 'flex';
        this.configBar.style.alignItems = 'center';
        this.configBar.style.justifyContent = 'space-between';
        this.configBar.style.gap = '8px';
        this.configBar.style.flexShrink = '0';
        this.configBar.style.flexWrap = 'wrap'; 

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

        this.readout = document.createElement('span');
        this.readout.style.fontSize = '0.85rem';
        this.readout.style.color = this.lineColor;
        this.readout.style.fontWeight = 'bold';
        this.readout.style.marginLeft = 'auto'; 
        this.readout.innerText = '--';

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

    setupCanvas() {
        this.ctx = this.canvas.getContext('2d');

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
                labels: [], 
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
                animation: false, 
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
                        enabled: true,             
                        intersect: false,          
                        mode: 'index',             
                        backgroundColor: '#1f2937', 
                        titleColor: '#9ca3af',      
                        bodyColor: '#e0e6ed',       
                        borderColor: '#374151',     
                        borderWidth: 1,
                        font: {
                            family: 'monospace'    
                        },
                        callbacks: {
                            title: function(context) {
                                return 'Tempo: ' + context[0].label;
                            },
                            label: function(context) {
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

refreshKeys(payload) {
        if (!payload) return;

        let validKeys = [];
        let dataSource;

        if (typeof window !== 'undefined' && window.currentMode && window.currentMode.dataTypes && window.currentMode.dataTypes.length > 0) {
            validKeys = window.currentMode.dataTypes;
            dataSource = payload;
        } else {
            dataSource = payload.values !== undefined ? payload.values : payload; 
            validKeys = Object.keys(dataSource);
        }

        validKeys = validKeys.filter(key => 
            key !== 'timestamp' && 
            key !== 'values' &&
            dataSource[key] !== undefined && 
            Number.isFinite(parseFloat(dataSource[key]))
        );

        for (const knownKey of Array.from(this.knownKeys)) {
            if (!validKeys.includes(knownKey)) {
                this.knownKeys.delete(knownKey);
                
                Array.from(this.select.options).forEach((opt, index) => {
                    if (opt.value === knownKey) this.select.remove(index);
                });
                
                delete this.buffers[knownKey];
            }
        }

        validKeys.forEach(key => {
            if (!this.knownKeys.has(key)) {
                this.knownKeys.add(key);
                
                const opt = document.createElement('option');
                opt.value = key;
                opt.innerText = key;

                if (this.select.options.length > 0 && this.select.options[0].value === '') {
                    this.select.remove(0);
                }
                
                this.select.appendChild(opt);
            }
        });
      
        if (this.selectedKey && !validKeys.includes(this.selectedKey)) {
            this.selectedKey = validKeys.length > 0 ? validKeys[0] : null;
            this.select.value = this.selectedKey || '';
            this.draw(); 
        } 
        else if (this.selectedKey === null && validKeys.length > 0) {
            this.selectedKey = validKeys[0];
            this.select.value = validKeys[0];
        }
    }

    update(new_data) {
        const payload = new_data || this.data;
        if (payload == undefined) return;
        if (this.paused) return; 

        this.refreshKeys(payload);

        const exactTimestamp = payload.timestamp || new Date().toLocaleTimeString(); 
        
        let dataSource;
        if (typeof window !== 'undefined' && window.currentMode && window.currentMode.dataTypes && window.currentMode.dataTypes.length > 0) {
            dataSource = payload;
        } else {
            dataSource = payload.values !== undefined ? payload.values : payload;
        }

        for (const [key, value] of Object.entries(dataSource)) {
            if (key === 'timestamp' || key === 'values') continue; 

            const num = parseFloat(value);
            if (!Number.isFinite(num)) continue;
            
            if (!this.buffers[key]) this.buffers[key] = [];
            const buf = this.buffers[key];
            
            buf.push({ value: num, time: exactTimestamp });

            if (buf.length > this.maxPoints) buf.shift();
        }

        this.draw();
    }

    clearData() {
        this.buffers = {};
        this.draw();
    }

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

        this.chart.data.datasets[0].borderColor = this.lineColor;
        this.chart.data.datasets[0].backgroundColor = this.lineColor;
        this.chart.data.datasets[0].pointBackgroundColor = this.lineColor;

        this.chart.data.labels = buf.map(item => this.formatChartTime(item.time));
        
        this.chart.data.datasets[0].data = buf.map(item => item.value);

        this.chart.update();

        this.readout.style.color = this.lineColor;
        this.readout.innerText = buf[buf.length - 1]['value'].toFixed(2);
    }

    formatChartTime(timestamp) {
        const parsed = new Date(timestamp);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
        }

        const timeMatch = String(timestamp).match(/\b\d{2}:\d{2}:\d{2}\b/);
        return timeMatch ? timeMatch[0] : String(timestamp);
    }
}
