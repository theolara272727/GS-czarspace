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

        this.elemento.appendChild(this.cabecalho);
        this.elemento.appendChild(this.conteudo);
    }

    setConteudo(htmlString) {
        this.conteudo.innerHTML = htmlString;
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