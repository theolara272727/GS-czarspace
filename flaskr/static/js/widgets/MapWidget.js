// Lembre-se de importar a classe pai (ajuste o caminho se necessário)
import BaseWidget from './BaseWidget.js';

export default class MapWidget extends BaseWidget {
    constructor(title, idContainerDestino) {
        super(title, idContainerDestino);

        this.aviaoFocado = null;
        this.marcadoresAtivos = {};
        this.ultimasCoordenadas = {};
        this.ultimosAngulos = {};

        this.mapContainer = document.createElement('div');
        this.mapId = 'mapa-' + Math.random().toString(36).substring(2, 9);
        this.mapContainer.id = this.mapId;
        this.mapContainer.className = 'map-container';

        this.content.appendChild(this.mapContainer);

        const observer = new ResizeObserver(() => {
            if (this.map) {
                this.map.invalidateSize();
            }
        });
        observer.observe(this.content);
    }

    render() {
        // 1. Manda o BaseWidget anexar o HTML na tela
        super.render();
        
        // 2. Inicializa o Leaflet (pois ele precisa que a div já exista na tela)
        setTimeout(() => {
            this.map = L.map(this.mapId).setView([-19.9167, -43.9345], 13);

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
    }

    calcularAnguloDirecao(idVoo,latAnterior, lngAnterior, latAtual, lngAtual) {
        if (latAnterior === latAtual && lngAnterior === lngAtual) {
            return this.ultimosAngulos[idVoo] || 0;
        }

        let dx = lngAtual - lngAnterior;
        let dy = latAtual - latAnterior;

        let anguloGraus = Math.atan2(dy, dx) * (180 / Math.PI);

        let anguloAjustado = 90 - anguloGraus;
        this.ultimosAngulos[idVoo] = anguloAjustado;
        
        return anguloAjustado;
    }

    atualizarAviao(dadosDoVoo) {
        if (!this.map) return; 

        let idVoo = dadosDoVoo.id;
        let lat = dadosDoVoo.lat;
        let lng = dadosDoVoo.lng;

        let coordAnterior = this.ultimasCoordenadas[idVoo] || { lat: lat, lng: lng };
        
        let angulo = this.calcularAnguloDirecao(idVoo, coordAnterior.lat, coordAnterior.lng, lat, lng);
        
        this.ultimasCoordenadas[idVoo] = { lat: lat, lng: lng };

        const gerarSVG = (cor, rotacao) => `
            <svg style="transform: rotate(${rotacao}deg); transform-origin: center; transition: transform 2s linear;" 
                 viewBox="0 0 24 24" width="38" height="38" xmlns="http://www.w3.org/2000/svg">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" 
                      fill="${cor}" />
            </svg>
        `;

        if (this.marcadoresAtivos[idVoo]) {
            let deveCentralizar = (this.aviaoFocado === idVoo);

            this.marcadoresAtivos[idVoo].slideTo([lat, lng], {
                duration: 2000,       
                keepAtCenter: deveCentralizar,   
            });

            let textoAtualizado = `<b>${idVoo}</b><br>${dadosDoVoo.lat}<br>${dadosDoVoo.lng}<br>${dadosDoVoo.altitude} ft`;
            this.marcadoresAtivos[idVoo].setTooltipContent(textoAtualizado);
            
            let novaCor = dadosDoVoo.altitude < 11000 ? "red" : "blue";
            let iconeAtualizado = L.divIcon({ 
                html: gerarSVG(novaCor, angulo), // Usa a função de gerar o SVG
                className: '', 
                iconSize: [38,38], 
                iconAnchor: [19,19] 
            });
            
            this.marcadoresAtivos[idVoo].setIcon(iconeAtualizado);
            
        } else {
            let corInicial = dadosDoVoo.altitude < 11000 ? "red" : "blue";

            let icone = L.divIcon({
                html: gerarSVG(corInicial, angulo),
                className: '',
                iconSize: [38, 38],
                iconAnchor: [19, 19]
            });

            let textoLateral = `<b>${idVoo}</b><br>${dadosDoVoo.lat}<br>${dadosDoVoo.lng}<br>${dadosDoVoo.altitude} ft`;
            
            let novoMarcador = L.marker([lat, lng], {icon: icone})
                .bindTooltip(textoLateral, { 
                    permanent: false,      
                    direction: 'right',    
                    offset: [15, 0],       
                    className: 'meu-tooltip' 
                })
                .addTo(this.map);
            
            novoMarcador.on('click', () => {
                if (this.aviaoFocado === idVoo) {
                    console.log(`Parando de focar no avião: ${idVoo}`);
                    this.aviaoFocado = null;
                } else {
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