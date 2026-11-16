import BaseWidget from './BaseWidget.js';
import { registerWidgetType } from './WidgetRegistry.js';

function finiteValue(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

class BatteryWidget extends BaseWidget {
    constructor(title, idContainerDestino, data) {
        super(title, idContainerDestino);
        this.minVoltage = null;
        this.maxVoltage = null;
        this.chargingPositive = true;
        this.voltageKey = 'V_bateria';
        this.currentKey = 'I_bateria';
        this.content.classList.add('battery-content');
        this.element.style.width = '340px';
        this.element.style.height = '280px';
        this.buildUI();
        this.update(data);
    }

    buildUI() {
        const toolbar = document.createElement('div');
        toolbar.className = 'battery-toolbar';
        this.status = document.createElement('span');
        this.status.className = 'battery-status';
        this.settingsButton = document.createElement('button');
        this.settingsButton.type = 'button';
        this.settingsButton.className = 'action-btn';
        this.settingsButton.textContent = '⚙';
        this.settingsButton.title = 'Configurações da bateria';
        this.settingsButton.setAttribute('aria-label', this.settingsButton.title);
        this.settingsButton.setAttribute('aria-expanded', 'false');
        toolbar.append(this.status, this.settingsButton);

        const display = document.createElement('div');
        display.className = 'battery-display';
        this.gauge = document.createElement('div');
        this.gauge.className = 'battery-gauge';
        this.gauge.setAttribute('role', 'progressbar');
        this.gauge.setAttribute('aria-label', 'Carga estimada da bateria');
        this.gauge.setAttribute('aria-valuemin', '0');
        this.gauge.setAttribute('aria-valuemax', '100');
        this.fill = document.createElement('div');
        this.fill.className = 'battery-fill';
        this.gauge.appendChild(this.fill);
        this.percentage = document.createElement('strong');
        this.percentage.className = 'battery-percentage';
        display.append(this.gauge, this.percentage);

        this.estimateLabel = document.createElement('span');
        this.estimateLabel.className = 'battery-estimate-label';
        const readings = document.createElement('div');
        readings.className = 'battery-readings';
        this.voltage = this.makeReading(readings, 'Tensão');
        this.current = this.makeReading(readings, 'Corrente');

        this.settingsPanel = document.createElement('div');
        this.settingsPanel.className = 'battery-settings';
        this.settingsPanel.hidden = true;
        this.voltageSelect = this.makeChannelSelect('Dado de tensão');
        this.currentSelect = this.makeChannelSelect('Dado de corrente');
        this.minInput = this.makeSetting('Tensão vazia (V)', 'number');
        this.maxInput = this.makeSetting('Tensão cheia (V)', 'number');
        const polarityLabel = document.createElement('label');
        polarityLabel.textContent = 'Corrente positiva';
        this.polarityInput = document.createElement('select');
        for (const [value, text] of [['charge', 'Carregando'], ['discharge', 'Descarregando']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            this.polarityInput.appendChild(option);
        }
        this.polarityInput.value = 'charge';
        polarityLabel.appendChild(this.polarityInput);
        this.settingsPanel.appendChild(polarityLabel);

        this.settingsButton.addEventListener('click', () => {
            this.settingsPanel.hidden = !this.settingsPanel.hidden;
            this.settingsButton.setAttribute('aria-expanded', String(!this.settingsPanel.hidden));
        });
        this.voltageSelect.addEventListener('change', () => {
            this.voltageKey = this.voltageSelect.value;
            this.update(this.data);
        });
        this.currentSelect.addEventListener('change', () => {
            this.currentKey = this.currentSelect.value;
            this.update(this.data);
        });
        for (const input of [this.minInput, this.maxInput, this.polarityInput]) {
            input.addEventListener('change', () => {
                this.minVoltage = finiteValue(this.minInput.value);
                this.maxVoltage = finiteValue(this.maxInput.value);
                this.chargingPositive = this.polarityInput.value === 'charge';
                this.update(this.data);
            });
        }
        this.content.append(toolbar, display, this.estimateLabel, readings, this.settingsPanel);
    }

    makeReading(container, title) {
        const item = document.createElement('div');
        const label = document.createElement('span');
        label.textContent = title;
        const value = document.createElement('strong');
        item.append(label, value);
        container.appendChild(item);
        return value;
    }

    makeSetting(title, type) {
        const label = document.createElement('label');
        label.textContent = title;
        const input = document.createElement('input');
        input.type = type;
        input.min = '0';
        input.step = 'any';
        label.appendChild(input);
        this.settingsPanel.appendChild(label);
        return input;
    }

    makeChannelSelect(title) {
        const label = document.createElement('label');
        label.textContent = title;
        const select = document.createElement('select');
        label.appendChild(select);
        this.settingsPanel.appendChild(label);
        return select;
    }

    refreshChannels(values) {
        const configured = window.currentMode?.dataTypes || [];
        const metadata = ['timestamp', 'collectionTimestamp', 'receivedTimestamp', 'modeCode', 'values'];
        const available = configured.length ? configured
            : Object.keys(values).filter(key => !metadata.includes(key) && finiteValue(values[key]) !== null);
        const keys = [...new Set([...available, this.voltageKey, this.currentKey])].filter(Boolean);
        const signature = JSON.stringify(keys);
        if (signature !== this.channelSignature) {
            this.channelSignature = signature;
            for (const select of [this.voltageSelect, this.currentSelect]) {
                select.replaceChildren();
                const empty = document.createElement('option');
                empty.value = '';
                empty.textContent = 'Nenhum';
                select.appendChild(empty);
                for (const key of keys) {
                    const option = document.createElement('option');
                    option.value = key;
                    option.textContent = key;
                    select.appendChild(option);
                }
            }
        }
        this.voltageSelect.value = this.voltageKey;
        this.currentSelect.value = this.currentKey;
    }

    hasVoltageRange() {
        return this.minVoltage !== null && this.maxVoltage !== null
            && this.minVoltage >= 0 && this.maxVoltage > this.minVoltage;
    }

    update(data) {
        this.data = data;
        const values = data?.values ?? data ?? {};
        this.refreshChannels(values);
        const voltage = finiteValue(values[this.voltageKey]);
        const current = finiteValue(values[this.currentKey]);
        this.voltage.textContent = voltage === null ? '— V' : `${voltage.toFixed(2)} V`;
        this.current.textContent = current === null ? '— A' : `${current > 0 ? '+' : ''}${current.toFixed(3)} A`;
        this.status.textContent = voltage === null ? 'Sem dados'
            : current === null ? 'Corrente indisponível'
            : current === 0 ? 'Em repouso'
            : (current > 0) === this.chargingPositive ? 'Carregando' : 'Descarregando';

        const configured = this.hasVoltageRange();
        this.estimateLabel.textContent = !configured ? ''
            : voltage === null ? 'Sem estimativa' : 'Estimativa linear por tensão';
        const percent = configured && voltage !== null
            ? Math.max(0, Math.min(100, (voltage - this.minVoltage) / (this.maxVoltage - this.minVoltage) * 100))
            : null;
        this.percentage.textContent = percent === null ? '—%' : `~${Math.round(percent)}%`;
        this.fill.style.width = `${percent ?? 0}%`;
        this.gauge.dataset.level = percent === null ? 'unknown' : percent <= 20 ? 'low' : percent <= 50 ? 'medium' : 'high';
        if (percent === null) {
            this.gauge.removeAttribute('aria-valuenow');
            this.gauge.setAttribute('aria-valuetext', 'Sem estimativa');
        } else {
            this.gauge.setAttribute('aria-valuenow', String(Math.round(percent)));
            this.gauge.setAttribute('aria-valuetext', `Carga estimada: ${Math.round(percent)}%`);
        }
    }

    serialize() {
        return {
            ...super.serialize(),
            voltageKey: this.voltageKey,
            currentKey: this.currentKey,
            minVoltage: this.minVoltage,
            maxVoltage: this.maxVoltage,
            chargingPositive: this.chargingPositive
        };
    }

    applyState(state = {}) {
        this.voltageKey = typeof state.voltageKey === 'string' ? state.voltageKey : 'V_bateria';
        this.currentKey = typeof state.currentKey === 'string' ? state.currentKey : 'I_bateria';
        this.minVoltage = finiteValue(state.minVoltage);
        this.maxVoltage = finiteValue(state.maxVoltage);
        this.chargingPositive = state.chargingPositive !== false;
        this.minInput.value = this.minVoltage ?? '';
        this.maxInput.value = this.maxVoltage ?? '';
        this.polarityInput.value = this.chargingPositive ? 'charge' : 'discharge';
        this.update(this.data);
    }

    clearData() {
        this.update(undefined);
    }
}

registerWidgetType('battery', BatteryWidget, 'Bateria');
export default BatteryWidget;
