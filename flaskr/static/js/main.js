import BaseWidget from './widgets/BaseWidget.js';
import terminalWidget from './widgets/terminalWidget.js';
import chartWidget from './widgets/ChartLine.js';

//Websocket
const socket = io();
let current_data = {};
const widget_list = [];
let savedModes = [];
let currentMode = null;

socket.on('new_data', (data) => {
    let new_data = {};

    if (currentMode != null && currentMode.dataTypes) {
        currentMode.dataTypes.forEach((key, index) => {
            if (data[index] !== undefined) {
                new_data[key] = data[index];
            }
        });
        Object.assign(current_data, new_data);
        socket.emit('save_telemetry', new_data);
    } else {
        Object.assign(current_data, data);
    }
    updateWidgets();
    
});


//Lógica de updates dos widgets

function updateWidgets() {
    for (let widget of widget_list) {
        widget.update();
    }
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

    mode.widgets.forEach((widgetSpec) => {
        const widget = createWidgetFromSpec(widgetSpec);
        widget_list.push(widget);
        widget.render();
    });
    updateWidgets();
}

function getCurrentModeSpec(name) {
    return {
        name,
        widgets: widget_list.map((widget) => {
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

          // Cabeçalho do Card
          const cardHeader = document.createElement('div');
          cardHeader.className = 'mode-header';
          
          const nameSpan = document.createElement('span');
          nameSpan.textContent = mode.name;
          
          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'delete-mode-btn';
          deleteBtn.innerHTML = '🗑️';
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
    const modesTab = document.getElementById('modes-tab');
    const settingsModeList = document.getElementById('settingsModeList');

    settingsButton.addEventListener('click', () => {
        settingsMenu.classList.add('open');
    });

    closeSettingsBtn.addEventListener('click', () => {
        settingsMenu.classList.remove('open');
    });


    document.querySelectorAll('.settings-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            setActiveTab(tab.dataset.target);
        });
    });

    // ABA DE BOTÕES
    const createNewTestButton = document.getElementById('testButton');
    createNewTestButton.addEventListener('click', () => {
        const widget = new BaseWidget('testWidget', 'workspace');
        widget_list.push(widget);
        widget.render();
    });

    const createRawDataButton = document.getElementById('rawDataButton');
    createRawDataButton.addEventListener('click', () => {
        const widget = new terminalWidget('Terminal', 'workspace', current_data);
        widget_list.push(widget);
        widget.render();
    });

    const createChartButton = document.getElementById('chartButton');
    createChartButton.addEventListener('click', () => {
        const widget = new chartWidget('Gráfico', 'workspace', current_data);
        widget_list.push(widget);
        widget.render();
    });

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
            existingMode.widgets = getCurrentModeSpec(name).widgets;
        } else {
            savedModes.push(getCurrentModeSpec(name));
        }

        await saveModesToServer();
    });
    
    saveModeButton.addEventListener('click', async () => {
        await saveModesToServer();
        renderModesUI(); 
    });

    await fetchModesFromServer();
    renderModesUI();
});