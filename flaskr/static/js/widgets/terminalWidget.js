import BaseWidget from "./BaseWidget.js"

export default class rawDataWidget extends BaseWidget{
    constructor(title, idContainerDestino, data){
        super(title,idContainerDestino)
        this.content.style.overflow = 'auto'; 
        this.content.style.height = '100%'; 
        this.lineCounter = 0;
        this.update()
        this.data = data;
        this.element.style.width = '300px'; 
        this.element.style.height = '200px';
    }

    getKind() {
        return 'terminal';
    }

    serialize() {
        return {
            ...super.serialize(),
            type: this.getKind()
        };
    }
    update(deltaTime){
        if(this.data != undefined){
            const time = new Date()
            const timeString = [
                time.getHours(),
                time.getMinutes(),
                time.getSeconds()
                ].map(unit => String(unit).padStart(2, '0')).join(':');
            let newLine = document.createElement('span');
            newLine.className = 'widgetLine'
            newLine.style.whiteSpace = 'nowrap';
            newLine.style.fontFamily = 'monospace'; 
            newLine.style.padding = '2px 4px';
            let line = "[" + timeString + "]"
            for (const [key, value] of Object.entries(this.data)){
                let formatted = typeof value === 'number' ? value.toFixed(2) : value;
                line += ` ${key}: ${formatted} |`;
            }
            const wasAtBottom = this.content.scrollHeight - this.content.scrollTop - this.content.clientHeight <= 15;

            newLine.innerText = line;
            if(this.lineCounter%2 == 1){
                newLine.style.backgroundColor = '#1f2937'
            }
            this.content.appendChild(newLine);

            if (wasAtBottom) {
                requestAnimationFrame(() => {
                    this.content.scrollTop = this.content.scrollHeight;
                });
            }
            this.lineCounter++
        }
    }
}