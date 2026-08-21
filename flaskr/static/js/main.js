import BaseWidget from './widgets/BaseWidget.js';
import terminalWidget from './widgets/terminalWidget.js';
import chartWidget from './widgets/ChartWidget.js';

const socket = io();
let current_data = {};
const widget_list = [];
let savedModes = [];
let currentMode = null;
let viewMode = "live";
let historicalRequestId = 0;
let historicalTimer = null;
let historicalPlaybackToken = 0;

socket.on('new_data', (data) => {
    let mapped_telemetry = {};

    if (currentMode != null && currentMode.dataTypes && currentMode.dataTypes.length > 0) {
        
        currentMode.dataTypes.forEach((key, index) => {
            if (data.values && data.values[index] !== undefined) {
                mapped_telemetry[key] = data.values[index];
            }
        });
        
        Object.assign(current_data, mapped_telemetry);
        current_data.timestamp = data.timestamp;
        
        socket.emit('save_telemetry', {
            timestamp: data.timestamp,
            telemetry: mapped_telemetry
        });
        
    } else {
        Object.assign(current_data, data);
    }
    
    if (viewMode === "live") {
        updateWidgets(current_data);
    }
});

socket.on('historical_data', (historicalData) => {
    if (viewMode !== 'historical') return;

    const response = typeof historicalData === 'string'
        ? JSON.parse(historicalData)
        : historicalData;

    if (response.requestId !== historicalRequestId) return;
    setHistoryLoading(false);

    if (!Array.isArray(response.samples) || response.samples.length === 0) {
        setHistoryStatus('Nenhum dado encontrado no intervalo selecionado.');
        return;
    }

    const speed = Number(document.getElementById('history-speed')?.value) || 1;
    playHistoricalSamples(response.samples, speed);
});

socket.on('historical_error', (error) => {
    if (viewMode !== 'historical') return;
    if (error?.requestId !== historicalRequestId) return;
    setHistoryLoading(false);
    setHistoryStatus(error?.message || 'Não foi possível recuperar o histórico.');
});

function updateWidgets(data_source) {
    for (let widget of widget_list) {
        widget.update(data_source);
    }
}

function clearWidgetData() {
    for (const widget of widget_list) {
        if (typeof widget.clearData === 'function') {
            widget.clearData();
        }
    }
}

function setHistoryStatus(message) {
    const status = document.getElementById('history-status');
    if (status) status.textContent = message;
}

function setHistoryLoading(isLoading) {
    const button = document.getElementById('fetch-history-btn');
    if (!button) return;
    button.disabled = isLoading;
    button.textContent = isLoading ? 'Buscando...' : 'Reproduzir';
}

function stopHistoricalPlayback(message = '') {
    historicalPlaybackToken += 1;
    if (historicalTimer !== null) {
        clearTimeout(historicalTimer);
        historicalTimer = null;
    }

    const stopButton = document.getElementById('stop-history-btn');
    if (stopButton) stopButton.style.display = 'none';
    if (message) setHistoryStatus(message);
}

function playHistoricalSamples(samples, speed) {
    stopHistoricalPlayback();
    clearWidgetData();

    const token = historicalPlaybackToken;
    const stopButton = document.getElementById('stop-history-btn');
    if (stopButton) stopButton.style.display = '';

    const playSample = (index) => {
        if (token !== historicalPlaybackToken || viewMode !== 'historical') return;

        updateWidgets(samples[index]);
        setHistoryStatus(`Reproduzindo ${index + 1} de ${samples.length} (${speed}x)`);

        if (index >= samples.length - 1) {
            historicalTimer = null;
            if (stopButton) stopButton.style.display = 'none';
            setHistoryStatus(`Reprodução concluída: ${samples.length} amostras.`);
            return;
        }

        const currentTime = Date.parse(samples[index].timestamp);
        const nextTime = Date.parse(samples[index + 1].timestamp);
        const elapsed = Number.isFinite(currentTime) && Number.isFinite(nextTime)
            ? Math.max(0, nextTime - currentTime)
            : 0;

        historicalTimer = setTimeout(() => playSample(index + 1), elapsed / speed);
    };

    playSample(0);
}

function registerWidget(widget) {
    widget_list.push(widget);

    widget.closeWidget.addEventListener('click', () => {
        const index = widget_list.indexOf(widget);
        if (index !== -1) {
            widget_list.splice(index, 1);
        }
    });

    return widget;
}

function clearWorkspace() {
    for (let widget of widget_list) {
        if (typeof widget.cleanup === 'function') {
            widget.cleanup();
        } else if (widget.element && widget.element.parentElement) {
            widget.element.remove();
        }
    }
    widget_list.length = 0;
}

function createWidgetFromSpec(spec) {
    let widget;
    const { type, title } = spec;

    if (type === 'chart') {
        widget = new chartWidget(title || 'Gráfico', 'workspace', current_data);
        if (typeof widget.applyState === 'function') {
            widget.applyState(spec);
        }
    } else if (type === 'terminal') {
        widget = new terminalWidget(title || 'Terminal', 'workspace', current_data);
    } else {
        widget = new BaseWidget(title || 'Widget', 'workspace');
    }

    if (typeof widget.restoreLayout === 'function') {
        widget.restoreLayout(spec);
    }

    return widget;
}

function isValidWidgetSpec(spec) {
    if (!spec || typeof spec !== 'object') return false;

    const hasInvalidWidth = spec.width != null && Number(spec.width) <= 0;
    const hasInvalidHeight = spec.height != null && Number(spec.height) <= 0;
    return !hasInvalidWidth && !hasInvalidHeight;
}

async function fetchModesFromServer() {
    try {
        const response = await fetch('/modes');
        if (!response.ok) throw new Error('Falha ao carregar modos');
        const data = await response.json();
        savedModes = Array.isArray(data.modes) ? data.modes : [];
    } catch (error) {
        console.error(error);
        savedModes = [];
    }
}

async function saveModesToServer() {
    try {
        const response = await fetch('/modes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modes: savedModes })
        });
        if (!response.ok) throw new Error('Falha ao salvar modos');
        await response.json();
    } catch (error) {
        console.error(error);
        alert('Não foi possível salvar os modos.');
    }
}

function loadMode(mode) {
    clearWorkspace();
    currentMode = mode;
    window.currentMode = mode;
    if (!Array.isArray(mode.widgets)) return;

    mode.widgets.filter(isValidWidgetSpec).forEach((widgetSpec) => {
        const widget = registerWidget(createWidgetFromSpec(widgetSpec));
        widget.render();
    });

    if (viewMode === 'live') {
        updateWidgets(current_data);
    } else {
        stopHistoricalPlayback('Modo alterado. Selecione um intervalo para reproduzir.');
    }
}

function getCurrentModeSpec(name) {
    const existingMode = savedModes.find(m => m.name === name);
    
    return {
        name,
        dataTypes: existingMode && existingMode.dataTypes ? existingMode.dataTypes : [],
        widgets: widget_list.filter((widget) => widget.element?.isConnected).map((widget) => {
            if (typeof widget.serialize === 'function') {
                return widget.serialize();
            }
            return {
                type: 'widget',
                title: widget.title || 'Widget'
            };
        })
    };
}

function renderModesUI() {
    const modesTab = document.getElementById('modes-tab');
    const settingsModeList = document.getElementById('settingsModeList');
    
    modesTab.innerHTML = '';
    settingsModeList.innerHTML = '';

    savedModes.forEach((mode, modeIndex) => {
        if (!mode.dataTypes) mode.dataTypes = [];

        const modeButton = document.createElement('div');
        modeButton.className = 'button';
        modeButton.textContent = mode.name;
        if (modeIndex === 0) modeButton.classList.add('active-mode');
        
        modeButton.addEventListener('click', (event) => {
            document.querySelectorAll('#modes-tab .button').forEach(btn => btn.classList.remove('active-mode'));
            event.target.classList.add('active-mode');
            loadMode(mode);
        });
        modesTab.appendChild(modeButton);

        const card = document.createElement('div');
        card.className = 'mode-card';

        const cardHeader = document.createElement('div');
        cardHeader.className = 'mode-header';
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = mode.name;
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-mode-btn';
        deleteBtn.title = 'Deletar Modo';
        deleteBtn.innerHTML = `
            <svg width="18" height="18" style="pointer-events: none; fill: none">
                <use href="#trash-svg"></use>
            </svg>
        `;
        deleteBtn.addEventListener('click', async () => {
            if (confirm(`Deletar o modo "${mode.name}"?`)) {
                savedModes = savedModes.filter(m => m.name !== mode.name);
                await saveModesToServer();
                renderModesUI();
            }
        });

        cardHeader.appendChild(nameSpan);
        cardHeader.appendChild(deleteBtn);
        card.appendChild(cardHeader);

        const dataSection = document.createElement('div');
        dataSection.className = 'data-types-section';

        const dataHeader = document.createElement('div');
        dataHeader.className = 'data-types-header';

        const addDataBtn = document.createElement('button');
        addDataBtn.className = 'add-datatype-btn';
        addDataBtn.textContent = '+';
        addDataBtn.addEventListener('click', async () => {
            const newType = await askInput('Tipo de dado:');
            if (newType) {
                mode.dataTypes.push(newType);
                await saveModesToServer();
                renderModesUI();
            }
        });
        dataHeader.appendChild(addDataBtn);
        dataSection.appendChild(dataHeader);

        const dataList = document.createElement('ul');
        dataList.className = 'data-types-list';

        let draggedItemIndex = null;

        mode.dataTypes.forEach((dataType, dtIndex) => {
            const dtItem = document.createElement('li');
            dtItem.className = 'data-type-item';
            dtItem.textContent = dataType;
            dtItem.draggable = true; 

            dtItem.addEventListener('dragstart', (e) => {
                draggedItemIndex = dtIndex;
                dtItem.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            dtItem.addEventListener('dragend', () => {
                dtItem.classList.remove('dragging');
                document.querySelectorAll('.data-type-item').forEach(el => el.classList.remove('drag-over'));
            });

            dtItem.addEventListener('dragover', (e) => {
                e.preventDefault(); 
                dtItem.classList.add('drag-over');
            });

            dtItem.addEventListener('dragleave', () => {
                dtItem.classList.remove('drag-over');
            });

            dtItem.addEventListener('drop', async (e) => {
                e.preventDefault();
                dtItem.classList.remove('drag-over');
                
                if (draggedItemIndex !== null && draggedItemIndex !== dtIndex) {
                    const itemToMove = mode.dataTypes.splice(draggedItemIndex, 1)[0];
                    mode.dataTypes.splice(dtIndex, 0, itemToMove);
                    
                    await saveModesToServer();
                    renderModesUI(); 
                }
            });

            const removeDtBtn = document.createElement('span');
            removeDtBtn.textContent = '×';
            removeDtBtn.style.cursor = 'pointer';
            removeDtBtn.style.color = '#ef4444';
            removeDtBtn.addEventListener('click', async () => {
                mode.dataTypes.splice(dtIndex, 1);
                await saveModesToServer();
                renderModesUI();
            });
            
            dtItem.appendChild(removeDtBtn);
            dataList.appendChild(dtItem);
        });

        dataSection.appendChild(dataList);
        card.appendChild(dataSection);
        settingsModeList.appendChild(card);
    });
} 

function askInput(title) {
    return new Promise((resolve) => {
        const modal = document.getElementById('inputModal');
        const titleEl = document.getElementById('inputModalTitle');
        const inputEl = document.getElementById('inputModalField');
        const confirmBtn = document.getElementById('inputModalConfirm');
        const cancelBtn = document.getElementById('inputModalCancel');

        titleEl.textContent = title;
        inputEl.value = '';
        modal.showModal();

        const onConfirm = () => { cleanup(); resolve(inputEl.value.trim()); };
        const onCancel = () => { cleanup(); resolve(null); };

        const cleanup = () => {
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            modal.close();
        };

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    const settingsButton = document.getElementById('settingsButton');
    const settingsMenu = document.getElementById('settingsMenu');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const saveModeButton = document.getElementById('saveModeButton');

    if (settingsButton) {
        settingsButton.innerHTML = `
            <svg width="22" height="22" style="pointer-events: none;color: #ffffff;fill: none">
                <use href="#config-svg"></use>
            </svg>
        `;
        settingsButton.addEventListener('click', () => {
            settingsMenu.classList.add('open');
        });
    }

    if (saveModeButton) {
        saveModeButton.innerHTML = `
            <svg width="18" height="18" style="pointer-events: none; margin-right: 6px;color: #ffffff;">
                <use href="#save-svg"></use>
            </svg>
        `;
    }

    closeSettingsBtn.addEventListener('click', () => {
        settingsMenu.classList.remove('open');
    });

    document.querySelectorAll('.settings-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            setActiveTab(tab.dataset.target);
        });
    });

    const createNewTestButton = document.getElementById('testButton');
    if (createNewTestButton) {
        createNewTestButton.addEventListener('click', () => {
            const widget = registerWidget(new BaseWidget('testWidget', 'workspace'));
            widget.render();
        });
    }

    const createRawDataButton = document.getElementById('rawDataButton');
    if (createRawDataButton) {
        createRawDataButton.addEventListener('click', () => {
            const widget = registerWidget(new terminalWidget('Terminal', 'workspace', current_data));
            widget.render();
        });
    }

    const createChartButton = document.getElementById('chartButton');
    if (createChartButton) {
        createChartButton.addEventListener('click', () => {
            const widget = registerWidget(new chartWidget('Gráfico', 'workspace', current_data));
            widget.render();
        });
    }
    if (saveModeButton) {
        saveModeButton.addEventListener('click', async () => {
            const name = await askInput('Nome do modo:');
            if (!name) {
                alert('Informe um nome para o modo.');
                return;
            }

            const existingMode = savedModes.find((mode) => mode.name === name);
            if (existingMode) {
                if (!confirm(`O modo "${name}" já existe. Atualizar com a disposição atual?`)) {
                    return;
                }
                existingMode.widgets = structuredClone(getCurrentModeSpec(name).widgets);            } 
            else {
                savedModes.push(getCurrentModeSpec(name));
            }

            await saveModesToServer();
            renderModesUI(); 
        });
    }

    const addWidgetBtn = document.getElementById('addWidgetBtn');
    const widgetDropdown = document.getElementById('widgetDropdown');

    if (addWidgetBtn && widgetDropdown) {
        addWidgetBtn.addEventListener('click', (e) => {
            e.stopPropagation(); 
            widgetDropdown.classList.toggle('show');
        });

        document.addEventListener('click', (e) => {
            if (!widgetDropdown.contains(e.target) && !addWidgetBtn.contains(e.target)) {
                widgetDropdown.classList.remove('show');
            }
        });

        widgetDropdown.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                widgetDropdown.classList.remove('show');
            });
        });
    }

const historyControls = document.getElementById('history-controls');
    const histStart = document.getElementById('hist-start');
    const histEnd = document.getElementById('hist-end');
    const fetchHistoryBtn = document.getElementById('fetch-history-btn');
    const stopHistoryBtn = document.getElementById('stop-history-btn');

    document.getElementById('btn-live').addEventListener('click', () => {
        viewMode = 'live';
        historicalRequestId += 1;
        stopHistoricalPlayback();
        setHistoryLoading(false);
        setHistoryStatus('');
        if (historyControls) historyControls.style.display = 'none'; 
        
        document.getElementById('btn-live').classList.add('active-source');
        document.getElementById('btn-history').classList.remove('active-source');
        updateWidgets(current_data);
    });

    document.getElementById('btn-history').addEventListener('click', () => {
        viewMode = 'historical';
        stopHistoricalPlayback();
        if (historyControls) historyControls.style.display = 'flex'; 
        
        document.getElementById('btn-history').classList.add('active-source');
        document.getElementById('btn-live').classList.remove('active-source');

        if (histEnd && !histEnd.value) {
            const now = new Date();
            now.setMinutes(now.getMinutes() - now.getTimezoneOffset()); 
            histEnd.value = now.toISOString().slice(0, 16); 
            
            const past = new Date(now.getTime() - 60 * 60 * 1000); 
            histStart.value = past.toISOString().slice(0, 16);
        }
    });

    if (fetchHistoryBtn) {
        fetchHistoryBtn.addEventListener('click', () => {
            if (!histStart.value || !histEnd.value) {
                alert('Por favor, selecione as datas de início e fim.');
                return;
            }

            const startUTC = new Date(histStart.value).toISOString();
            const endUTC = new Date(histEnd.value).toISOString();

            if (startUTC >= endUTC) {
                setHistoryStatus('A data inicial deve ser anterior à data final.');
                return;
            }

            stopHistoricalPlayback();
            clearWidgetData();
            historicalRequestId += 1;
            setHistoryLoading(true);
            setHistoryStatus('Buscando dados...');

            socket.emit('time_series', { 
                start: startUTC, 
                end: endUTC,
                requestId: historicalRequestId
            });
        });
    }

    if (stopHistoryBtn) {
        stopHistoryBtn.addEventListener('click', () => {
            stopHistoricalPlayback('Reprodução interrompida.');
        });
    }

    await fetchModesFromServer();
    renderModesUI();
});
