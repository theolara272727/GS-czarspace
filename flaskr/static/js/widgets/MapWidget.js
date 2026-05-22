export default class MapWidget {
    constructor(title, idContainerDestino) {
        this.title = title;
        this.containerDestino = document.getElementById(idContainerDestino);
        this.aviaoFocado = null;

        this.AirplaneIcon = L.Icon.extend({
            options: {
                iconUrl: '/static/img/plane.png', 
                // shadowUrl: 'caminho/para/sua/sombra.png',
                iconSize:     [38, 38], 
                iconAnchor:   [19, 19], 
                popupAnchor:  [0, -20]
            }
        });
        
        this.marcadoresAtivos = {};

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

        this.mapContainer = document.createElement('div');

        // Gera um ID único e aleatório para este mapa (ex: mapa-a8b2x9)
        this.mapId = 'mapa-' + Math.random().toString(36).substring(2, 9);
        this.mapContainer.id = this.mapId;
        this.mapContainer.className = 'map-container';

        this.content.appendChild(this.mapContainer);

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
            if (isResizing) {
                isResizing = false;

                if (this.map) {
                    this.map.invalidateSize();
                }
            }
        })


    }

    render() {
        if (this.containerDestino) {
            this.containerDestino.appendChild(this.element);
            
            setTimeout(() => {
                // As coordenadas [-19.9167, -43.9345] centralizam em Belo Horizonte, com zoom 13
                this.map = L.map(this.mapId).setView([-19.9167, -43.9345], 13);

                // Adiciona os blocos de imagens (ruas, bairros) gratuitos do OpenStreetMap
                L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                }).addTo(this.map);
                
                const soltarCamera = () => {
                    if (this.aviaoFocado !== null) {
                        
                        let idDoAviaoSeguido = this.aviaoFocado;
                        
                        this.aviaoFocado = null; 
                        
                        let aviao = this.marcadoresAtivos[idDoAviaoSeguido];
                        if (aviao) {
                            aviao.slideTo(aviao.getLatLng(), {
                                duration: 0,
                                keepAtCenter: false
                            });
                        }
                    }
                };
                
                this.map.on('dragstart', soltarCamera);
                this.map.on('click', soltarCamera);
            }, 0);

        } else {
            console.error("Contêiner de destino não encontrado");
        }
    }

    atualizarAviao(dadosDoVoo) {
        if (!this.map) return; 

        let idVoo = dadosDoVoo.id;
        let lat = dadosDoVoo.lat;
        let lng = dadosDoVoo.lng;

        if (this.marcadoresAtivos[idVoo]) {
            
            let deveCentralizar = (this.aviaoFocado === idVoo);

            this.marcadoresAtivos[idVoo].slideTo([lat, lng], {
                duration: 2000,       
                keepAtCenter: deveCentralizar,   
            });
            let textoAtualizado = `<b>${idVoo}</b><br>${dadosDoVoo.lat}<br>${dadosDoVoo.lng}<br>${dadosDoVoo.altitude} ft`;
            
            this.marcadoresAtivos[idVoo].setTooltipContent(textoAtualizado);
            
        } else {
            let iconeDoVoo = new this.AirplaneIcon();
            let textoLateral = `<b>${idVoo}</b><br>${dadosDoVoo.lat}<br>${dadosDoVoo.lng}<br>${dadosDoVoo.altitude} ft`;
            let novoMarcador = L.marker([lat, lng], {icon: iconeDoVoo})
                .bindTooltip(textoLateral, { 
                    permanent: false,       // Mantém o texto sempre visível
                    direction: 'right',    // Posiciona o texto à direita do avião
                    offset: [15, 0],       // Afasta o texto 15 pixels para não cobrir o desenho
                    className: 'meu-tooltip' // Classe CSS opcional para você estilizar depois
                })
                .addTo(this.map);
            
            novoMarcador.on('click', () => {
                
                if (this.aviaoFocado === idVoo) {
                    console.log(`Parando de focar no avião: ${idVoo}`);
                    this.aviaoFocado = null;
                } 
                else {
                    console.log(`Focando no avião: ${idVoo}`);
                    this.aviaoFocado = idVoo; 
                }
                
            });
            
            this.marcadoresAtivos[idVoo] = novoMarcador;
        }
    }

    update(dados) {
        if (dados && dados.avioes) {
            
            for (let aviaoAtual of dados.avioes) {
                this.atualizarAviao(aviaoAtual);
            }
        }
    }
}