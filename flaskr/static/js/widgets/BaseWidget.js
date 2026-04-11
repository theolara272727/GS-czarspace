export default class BaseWidget {
    constructor(title, idContainerDestino) {
        this.title = title;
        this.containerDestino = document.getElementById(idContainerDestino);

        this.element = document.createElement('div');
        this.element.className = 'widget';

        this.header = document.createElement('div');
        this.header.className = 'widget-header';

        this.titleSpan = document.createElement('span');
        this.titleSpan.innerText = this.title;

        this.closeWidget = document.createElement('div');
        this.closeWidget.className = 'widget-close';
        this.closeWidget.innerHTML = '&times;'; 

        this.header.appendChild(this.titleSpan);
        this.header.appendChild(this.closeWidget);

        this.content = document.createElement('div');
        this.content.className = 'widget-content';

        this.resize_handle = document.createElement('div');
        this.resize_handle.className = 'widget-resize-handle';


        this.element.appendChild(this.header);
        this.element.appendChild(this.content);
        this.element.appendChild(this.resize_handle)

        //configuracao de eventos
        this.configEvents();
    }

    setContent(htmlString) {
        this.content.innerHTML = htmlString;
    }

    configEvents(){
        let isDragging = false;
        let isResizing = false;
        let startX, startY, initialX, initialY, initialWidth, initialHeight;
        let gridSize = 20;

        //Lógica de fechamento
        this.closeWidget.addEventListener('mousedown', (e) => {
            e.stopPropagation(); 
        });

        this.closeWidget.addEventListener('click', () => {
            this.element.remove(); 
        });

        //Lógica de resize 'snap-to-grid'
        this.header.addEventListener('mousedown',(e) => {
            isDragging = true;

            startX = e.clientX;
            startY = e.clientY;

            initialX = this.element.offsetLeft;
            initialY = this.element.offsetTop;
        })

        //Lógica de arraste 'snap-to-grid'
        this.resize_handle.addEventListener('mousedown', (e) => {
            e.stopPropagation(); 
            e.preventDefault();
            
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            initialWidth = this.element.offsetWidth;
            initialHeight = this.element.offsetHeight;
        });

        document.addEventListener('mousemove',(e) => {
            if (isDragging){
                let rawX = initialX + e.clientX - startX;
                let rawY = initialY + e.clientY - startY;

                let snappedX = Math.round(rawX / gridSize) * gridSize;
                let snappedY = Math.round(rawY / gridSize) * gridSize;

                const limiteLargura = this.containerDestino.clientWidth;
                const limiteAltura = this.containerDestino.clientHeight;

                const maxX = limiteLargura - this.element.offsetWidth;
                const maxY = limiteAltura - this.element.offsetHeight;

                snappedX = Math.max(0, Math.min(snappedX, maxX));
                snappedY = Math.max(0, Math.min(snappedY, maxY));

                this.element.style.left = `${snappedX}px`;
                this.element.style.top = `${snappedY}px`;
            }
            if (isResizing){
                let rawWidth = initialWidth + (e.clientX - startX);
                let rawHeight = initialHeight + (e.clientY - startY);

                let snappedWidth = Math.round(rawWidth / gridSize) * gridSize;
                let snappedHeight = Math.round(rawHeight / gridSize) * gridSize;

                const maxWidth = this.containerDestino.clientWidth - this.element.offsetLeft;
                const maxHeight = this.containerDestino.clientHeight - this.element.offsetTop;

                snappedWidth = Math.max(260, Math.min(snappedWidth, maxWidth));
                snappedHeight = Math.max(200, Math.min(snappedHeight, maxHeight));

                this.element.style.width = `${snappedWidth}px`;
                this.element.style.height = `${snappedHeight}px`;
            }
        })

        document.addEventListener('mouseup',() =>{
            isDragging = false;
            isResizing = false;
        } )


    }

    render() {
        if (this.containerDestino) {
            this.containerDestino.appendChild(this.element);
        } else {
            console.error("Contêiner de destino não encontrado");
        }
    }
    update(deltaTime){

    }
}