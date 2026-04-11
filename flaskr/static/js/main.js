// static/js/main.js

class JanelaWidget {
    constructor(titulo, idContainerDestino) {
        this.titulo = titulo;
        this.containerDestino = document.getElementById(idContainerDestino);

        this.elemento = document.createElement('div');
        this.elemento.className = 'widget';

        this.cabecalho = document.createElement('div');
        this.cabecalho.className = 'widget-header';
        this.cabecalho.innerText = this.titulo;

        this.conteudo = document.createElement('div');
        this.conteudo.className = 'widget-content';

        this.resize_handle = document.createElement('div');
        this.resize_handle.className = 'widget-resize-handle';


        this.elemento.appendChild(this.cabecalho);
        this.elemento.appendChild(this.conteudo);
        this.elemento.appendChild(this.resize_handle)

        //configuracao de eventos
        this.configurarEventos();
    }

    setConteudo(htmlString) {
        this.conteudo.innerHTML = htmlString;
    }

    configurarEventos(){
        let isDragging = false;
        let isResizing = false;
        let startX, startY, initialX, initialY, initialWidth, initialHeight;
        let gridSize = 20;

        //Lógica de resize 'snap-to-grid'
        this.cabecalho.addEventListener('mousedown',(e) => {
            isDragging = true;

            startX = e.clientX;
            startY = e.clientY;

            initialX = this.elemento.offsetLeft;
            initialY = this.elemento.offsetTop;
        })

        //Lógica de arraste 'snap-to-grid'
        this.resize_handle.addEventListener('mousedown', (e) => {
            e.stopPropagation(); 
            e.preventDefault();
            
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            initialWidth = this.elemento.offsetWidth;
            initialHeight = this.elemento.offsetHeight;
        });

        document.addEventListener('mousemove',(e) => {
            if (isDragging){
                let rawX = initialX + e.clientX - startX;
                let rawY = initialY + e.clientY - startY;

                let snappedX = Math.round(rawX / gridSize) * gridSize;
                let snappedY = Math.round(rawY / gridSize) * gridSize;

                const limiteLargura = this.containerDestino.clientWidth;
                const limiteAltura = this.containerDestino.clientHeight;

                const maxX = limiteLargura - this.elemento.offsetWidth;
                const maxY = limiteAltura - this.elemento.offsetHeight;

                snappedX = Math.max(0, Math.min(snappedX, maxX));
                snappedY = Math.max(0, Math.min(snappedY, maxY));

                this.elemento.style.left = `${snappedX}px`;
                this.elemento.style.top = `${snappedY}px`;
            }
            if (isResizing){
                let rawWidth = initialWidth + (e.clientX - startX);
                let rawHeight = initialHeight + (e.clientY - startY);

                let snappedWidth = Math.round(rawWidth / gridSize) * gridSize;
                let snappedHeight = Math.round(rawHeight / gridSize) * gridSize;

                const maxWidth = this.containerDestino.clientWidth - this.elemento.offsetLeft;
                const maxHeight = this.containerDestino.clientHeight - this.elemento.offsetTop;

                snappedWidth = Math.max(260, Math.min(snappedWidth, maxWidth));
                snappedHeight = Math.max(200, Math.min(snappedHeight, maxHeight));

                this.elemento.style.width = `${snappedWidth}px`;
                this.elemento.style.height = `${snappedHeight}px`;
            }
        })

        document.addEventListener('mouseup',() =>{
            isDragging = false;
            isResizing = false;
        } )


    }


    renderizar() {
        if (this.containerDestino) {
            this.containerDestino.appendChild(this.elemento);
        } else {
            console.error("Contêiner de destino não encontrado!");
        }
    }
}
//Funcionalidade de butoes

const createNewTestButton = document.getElementById("testButton")
createNewTestButton.addEventListener('click', () => {

  const testWidget = new JanelaWidget("testWidget","workspace");
  testWidget.renderizar();
});

document.addEventListener('DOMContentLoaded', () => {
    


});