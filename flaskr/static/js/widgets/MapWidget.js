import BaseWidget from './BaseWidget.js';
import { registerWidgetType } from './WidgetRegistry.js';

class MapWidget extends BaseWidget {
    constructor(title, idContainerDestino) {
        super(title, idContainerDestino);

        this.aviaoFocado = null;
        this.marcadoresAtivos = {};
        this.ultimasCoordenadas = {}; // Para o cálculo do ângulo visual
        this.ultimosAngulos = {};
        
        // NOVAS VARIÁVEIS PARA O RASTRO E INFORMAÇÕES
        this.linhasDeRastro = {}; // Guarda as polylines de cada avião
        this.historicoPosicoes = {}; // Guarda as coordenadas para desenhar a linha

        this.mapContainer = document.createElement('div');
        this.mapId = 'mapa-' + Math.random().toString(36).substring(2, 9);
        this.mapContainer.id = this.mapId;
        this.mapContainer.className = 'map-container';
        this.mapContainer.style.position = 'relative'; // Necessário para o painel flutuante
        this.mapContainer.style.height = '100%'; // Garante que o mapa ocupe o widget

        // CRIAÇÃO DO PAINEL DE INFORMAÇÕES (Oculto por padrão)
        this.infoPanel = document.createElement('div');
        this.infoPanel.className = 'map-info-panel';
        this.infoPanel.style.cssText = `
            position: absolute;
            top: 10px;
            right: 10px;
            width: 220px;
            background: rgba(0, 0, 0, 0.8);
            color: #fff;
            padding: 15px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 13px;
            z-index: 1000;
            display: none;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            border: 1px solid #444;
        `;
        this.mapContainer.appendChild(this.infoPanel);

        this.content.appendChild(this.mapContainer);

        this.resizeObserver = new ResizeObserver(() => {
            if (this.map) {
                this.map.invalidateSize();
            }
        });
        this.resizeObserver.observe(this.content);

        this.closeWidget.addEventListener('click', () => this.destroyMap());
    }

    render() {
        super.render();
        
        this.renderTimer = setTimeout(() => {
            this.renderTimer = null;
            if (!this.mapContainer.isConnected) return;

            this.map = L.map(this.mapId).setView([-19.9167, -43.9345], 13);

            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            }).addTo(this.map);
            
            const soltarCamera = () => {
                // 1. Esconde o painel imediatamente, independente de ter avião focado ou não
                if (this.infoPanel) {
                    this.infoPanel.style.display = 'none';
                }
                
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

    destroyMap() {
        if (this.renderTimer != null) {
            clearTimeout(this.renderTimer);
            this.renderTimer = null;
        }
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
    }

    obterCorPorAltitude(altitude) {
        if (altitude < 5000)  return '#d03379'; // Rosa 
        if (altitude < 10000) return '#d08a33'; // Laranja
        if (altitude < 15000) return '#d0d033'; // Amarelo
        if (altitude < 20000) return '#33d08a'; // Verde
        if (altitude < 30000) return '#33d0d0'; // Ciano
        if (altitude < 40000) return '#3379d0'; // Azul 
        return '#a333d0';                       // Roxo 
    }

    calcularAnguloDirecao(idVoo, latAnterior, lngAnterior, latAtual, lngAtual) {
        let dx = lngAtual - lngAnterior;
        let dy = latAtual - latAnterior;
        let distancia = Math.sqrt(dx * dx + dy * dy);
        
        if (distancia < 0.00005) { 
            return { angulo: this.ultimosAngulos[idVoo] || 0, atualizaFiltro: false };
        }

        let anguloGraus = Math.atan2(dy, dx) * (180 / Math.PI);
        let anguloAjustado = (90 - anguloGraus + 360) % 360;
        let anguloAnterior = this.ultimosAngulos[idVoo] || 0;
        let anguloAnteriorBase = (anguloAnterior % 360 + 360) % 360; 
        
        let diferenca = anguloAjustado - anguloAnteriorBase;
        if (diferenca > 180) diferenca -= 360;
        if (diferenca <= -180) diferenca += 360; 

        let anguloFinal = anguloAnterior + diferenca;
        this.ultimosAngulos[idVoo] = anguloFinal;
        return { angulo: anguloFinal, atualizaFiltro: true };
    }
    
    // NOVA FUNÇÃO: Atualiza os dados no painel HTML
    atualizarPainel(dadosDoVoo) {
        this.infoPanel.innerHTML = `
            <div style="font-size: 16px; font-weight: bold; border-bottom: 1px solid #555; padding-bottom: 5px; margin-bottom: 10px; color: #ffeb3b;">
                Flight: ${dadosDoVoo.id}
            </div>
            <div><span style="color:#aaa;">Hex:</span> ${dadosDoVoo.hex || 'N/A'}</div>
            <div><span style="color:#aaa;">Alt:</span> ${dadosDoVoo.altitude} ft</div>
            <div><span style="color:#aaa;">Speed:</span> ${dadosDoVoo.speed || 0} kt</div>
            <div><span style="color:#aaa;">Track:</span> ${dadosDoVoo.track || 0}°</div>
            <div style="margin-top: 10px; border-top: 1px dashed #555; padding-top: 5px;">
                <span style="color:#aaa;">Lat:</span> ${dadosDoVoo.lat} <br>
                <span style="color:#aaa;">Lon:</span> ${dadosDoVoo.lng}
            </div>
        `;
    }

    atualizarAviao(dadosDoVoo) {
        if (!this.map) return; 

        let idVoo = dadosDoVoo.id;
        let lat = dadosDoVoo.lat;
        let lng = dadosDoVoo.lng;
        let corDin = '#230838';
        // let corDin = this.obterCorPorAltitude(dadosDoVoo.altitude);

        // --- LÓGICA DO RASTRO (TRACK/POLYLINE) ---
        if (!this.historicoPosicoes[idVoo]) {
            this.historicoPosicoes[idVoo] = [];
        }
        
        // Adiciona a nova posição ao histórico
        let novaPosicao = [lat, lng];
        this.historicoPosicoes[idVoo].push(novaPosicao);
        
        // Limita o histórico a 100 pontos para não pesar a memória
        if (this.historicoPosicoes[idVoo].length > 100) {
            this.historicoPosicoes[idVoo].shift();
        }

        // Desenha ou atualiza a linha no mapa
        if (this.linhasDeRastro[idVoo]) {
            this.linhasDeRastro[idVoo].setLatLngs(this.historicoPosicoes[idVoo]);
            this.linhasDeRastro[idVoo].setStyle({ color: corDin }); // Atualiza a cor da linha se a altitude mudar
        } else {
            this.linhasDeRastro[idVoo] = L.polyline(this.historicoPosicoes[idVoo], {
                color: corDin,
                weight: 2,
                opacity: 0.6,
                dashArray: '5, 5' // Faz a linha ser tracejada
            }).addTo(this.map);
        }
        // ------------------------------------------

        let coordAnterior = this.ultimasCoordenadas[idVoo];
        if (!coordAnterior) {
            coordAnterior = { lat: lat, lng: lng };
            this.ultimasCoordenadas[idVoo] = coordAnterior;
        }

        let resultado = this.calcularAnguloDirecao(idVoo, coordAnterior.lat, coordAnterior.lng, lat, lng);
        let angulo = resultado.angulo;
        
        if (resultado.atualizaFiltro) {
            this.ultimasCoordenadas[idVoo] = { lat: lat, lng: lng };
        }

        const gerarSVG = (cor, rotacao) => `
            <svg style="transform: rotate(${rotacao}deg); transform-origin: center; transition: transform 1.5s ease-out;" 
                 viewBox="0 0 24 24" width="38" height="38" xmlns="http://www.w3.org/2000/svg">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" 
                      fill="${cor}" style="transition: fill 1.5s ease-out;" />
            </svg>
        `;

        // TEXTO DO HOVER (Agora mostra só o ID)
        let tooltipSimples = `<b>${idVoo}</b>`;

        if (this.marcadoresAtivos[idVoo]) {
            let marker = this.marcadoresAtivos[idVoo];
            let deveCentralizar = (this.aviaoFocado === idVoo);

            marker.slideTo([lat, lng], {
                duration: 2000,       
                keepAtCenter: deveCentralizar,   
            });

            marker.setTooltipContent(tooltipSimples);
            
            // Se este for o avião atualmente focado, atualiza o painel lateral em tempo real
            if (deveCentralizar) {
                this.atualizarPainel(dadosDoVoo);
            }
            
            let iconElement = marker.getElement();
            if (iconElement) {
                let svg = iconElement.querySelector('svg');
                if (svg) {
                    svg.style.transform = `rotate(${angulo}deg)`;
                    let path = svg.querySelector('path');
                    if (path) path.setAttribute('fill', corDin);
                }
            }
            
        } else {
            let icone = L.divIcon({
                html: gerarSVG(corDin, angulo),
                className: '',
                iconSize: [38, 38],
                iconAnchor: [19, 19]
            });
            
            let novoMarcador = L.marker([lat, lng], {icon: icone})
                .bindTooltip(tooltipSimples, { 
                    permanent: false,      
                    direction: 'right',    
                    offset: [15, 0],       
                    className: 'meu-tooltip' 
                })
                .addTo(this.map);
            
            novoMarcador.on('click', () => {
                // Alterna o foco do avião
                if (this.aviaoFocado === idVoo) {
                    this.aviaoFocado = null;
                    this.infoPanel.style.display = 'none'; // Esconde painel
                } else {
                    this.aviaoFocado = idVoo; 
                    this.atualizarPainel(dadosDoVoo); // Preenche painel
                    this.infoPanel.style.display = 'block'; // Mostra painel
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

    cleanup() {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.destroyMap();
        super.cleanup();
    }
}

registerWidgetType('map', MapWidget, 'Mapa');

export default MapWidget;