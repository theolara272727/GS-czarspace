import BaseWidget from './BaseWidget.js';
import { registerWidgetType } from './WidgetRegistry.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

class ConstellationWidget extends BaseWidget {
    static widgetType = 'constellation';

    constructor(title, idContainerDestino, initialData = {}) {
        super(title, idContainerDestino);
        
        this.element.style.width = '480px';
        this.element.style.height = '360px';

        // Container exclusivo do Canvas
        this.canvasContainer = document.createElement('div');
        this.canvasContainer.style.width = '100%';
        this.canvasContainer.style.height = '100%';
        this.canvasContainer.style.overflow = 'hidden';
        this.content.appendChild(this.canvasContainer);

        // Painel HUD fixo no canto
        this.hud = document.createElement('div');
        this.hud.style.position = 'absolute';
        this.hud.style.top = '35px';
        this.hud.style.left = '10px';
        this.hud.style.color = '#991052';
        this.hud.style.fontSize = '11px';
        this.hud.style.fontFamily = 'monospace';
        this.hud.style.pointerEvents = 'none';
        this.element.appendChild(this.hud);

        // --- Label flutuante (Tooltip) ---
        this.tooltip = document.createElement('div');
        this.tooltip.style.position = 'absolute';
        this.tooltip.style.backgroundColor = 'rgba(15, 23, 42, 0.9)'; 
        this.tooltip.style.color = '#fff';
        this.tooltip.style.padding = '8px 12px';
        this.tooltip.style.borderRadius = '6px';
        this.tooltip.style.fontSize = '12px';
        this.tooltip.style.border = '1px solid #af2468';
        this.tooltip.style.pointerEvents = 'none'; // Evita bloquear os cliques do mouse
        this.tooltip.style.display = 'none'; // Invisível por padrão
        this.tooltip.style.zIndex = '1000';
        this.element.appendChild(this.tooltip);

        // --- Variável de estado da câmera ---
        this.isAutoZoomEnabled = true;

        // --- Botão de Toggle da Visão (Auto-Zoom) ---
        this.cameraToggleBtn = document.createElement('button');
        this.cameraToggleBtn.style.position = 'absolute';
        this.cameraToggleBtn.style.top = '35px'; // Alinhado com o HUD
        this.cameraToggleBtn.style.right = '10px';
        this.cameraToggleBtn.style.backgroundColor = 'rgba(15, 23, 42, 0.9)';
        this.cameraToggleBtn.style.color = '#22c55e'; // Verde indicando ON
        this.cameraToggleBtn.style.border = '1px solid #22c55e';
        this.cameraToggleBtn.style.padding = '4px 8px';
        this.cameraToggleBtn.style.borderRadius = '4px';
        this.cameraToggleBtn.style.fontSize = '10px';
        this.cameraToggleBtn.style.fontFamily = 'monospace';
        this.cameraToggleBtn.style.cursor = 'pointer';
        this.cameraToggleBtn.style.zIndex = '100';
        this.cameraToggleBtn.innerText = 'AUTO-ZOOM: ON';
        this.element.appendChild(this.cameraToggleBtn);

        // Lógica de clique do botão
        this.cameraToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Evita conflitos com o arraste do widget
            this.isAutoZoomEnabled = !this.isAutoZoomEnabled;
            
            if (this.isAutoZoomEnabled) {
                this.cameraToggleBtn.innerText = 'AUTO-ZOOM: ON';
                this.cameraToggleBtn.style.color = '#22c55e';
                this.cameraToggleBtn.style.borderColor = '#22c55e';
                this.adjustCameraZoom(); // Ajusta imediatamente ao religar
            } else {
                this.cameraToggleBtn.innerText = 'VIEW: MANUAL';
                this.cameraToggleBtn.style.color = '#94a3b8'; // Cinza indicando OFF
                this.cameraToggleBtn.style.borderColor = '#94a3b8';
            }
        });

        // Variáveis de Interação
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.selectedNodes = []; 
        this.dynamicLines = []; 
        this.hoveredNode = null; // Armazena o objeto atual sob o mouse

        this.initThree();
        this.setupConstellationObjects();
        this.setupInteraction(); 
        this.observeResize();

        if (initialData) this.update(initialData);
    }

    initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0e17);

        this.camera = new THREE.PerspectiveCamera(50, this.canvasContainer.clientWidth / this.canvasContainer.clientHeight || 1, 0.1, 5000);
        this.camera.position.set(0, -100, 150);
        this.camera.up.set(0, 0, 1);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.canvasContainer.clientWidth, this.canvasContainer.clientHeight);
        this.canvasContainer.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;

        this.controls.enablePan = true;
        this.controls.screenSpacePanning = true;
        const MAX_POLAR = Math.PI / 2; // Nível do solo (90 graus)
        this.controls.maxPolarAngle = MAX_POLAR; // Impede a câmera de ir para baixo do chão
        
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 2.5); // Luz branca simulando o sol
        directionalLight.position.set(20, 50, 50);
        
        this.scene.add(ambientLight, directionalLight);

        const grid = new THREE.GridHelper(500, 20, 0x1e293b, 0x0f172a);
        grid.rotation.x = Math.PI / 2;
        this.scene.add(grid);

        let isPointerDown = false;
        let axisLocked = false;
        let startX = 0;
        let startY = 0;

        this.renderer.domElement.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return; // Só aplica no clique esquerdo (rotação)
            
            isPointerDown = true;
            axisLocked = false;
            startX = e.clientX;
            startY = e.clientY;

            // Zera qualquer trava anterior
            this.controls.minAzimuthAngle = -Infinity;
            this.controls.maxAzimuthAngle = Infinity;
            this.controls.minPolarAngle = 0;
            this.controls.maxPolarAngle = MAX_POLAR;
        });

        this.renderer.domElement.addEventListener('pointermove', (e) => {
            if (!isPointerDown || axisLocked) return;

            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);

            // Aguarda o mouse mover 5 pixels para decidir a direção dominante
            if (dx > 5 || dy > 5) {
                axisLocked = true; // Trava o eixo para esse movimento
                
                if (dx > dy) {
                    // Arrastou mais na Horizontal: Trava o movimento Vertical (Polar)
                    const currentPolar = this.controls.getPolarAngle();
                    this.controls.minPolarAngle = currentPolar;
                    this.controls.maxPolarAngle = currentPolar;
                } else {
                    // Arrastou mais na Vertical: Trava o movimento Horizontal (Azimuthal)
                    const currentAzimuth = this.controls.getAzimuthalAngle();
                    this.controls.minAzimuthAngle = currentAzimuth;
                    this.controls.maxAzimuthAngle = currentAzimuth;
                }
            }
        });

        const resetLocks = () => {
            isPointerDown = false;
            axisLocked = false;
            // Libera as travas para que o "damping" (deslizamento suave) termine
            this.controls.minAzimuthAngle = -Infinity;
            this.controls.maxAzimuthAngle = Infinity;
            this.controls.minPolarAngle = 0;
            this.controls.maxPolarAngle = MAX_POLAR;
        };

        // Quando solta ou tira o mouse da tela, reseta as travas
        this.renderer.domElement.addEventListener('pointerup', resetLocks);
        this.renderer.domElement.addEventListener('pointerout', resetLocks);

        this.isRunning = true;
        const animate = () => {
            if (!this.isRunning) return;
            requestAnimationFrame(animate);
            this.controls.update();
            this.updateLines();
            this.renderer.render(this.scene, this.camera);
        };
        animate();
    }

    setupConstellationObjects() {
        this.group = new THREE.Group();
        this.scene.add(this.group);

        const satGeometry1u = new THREE.BoxGeometry(4, 4, 4);
        const satGeometry2u = new THREE.BoxGeometry(4, 4, 8);
        const groundStationGeometry = new THREE.BoxGeometry(10, 8, 4);

        const satColor = 0xba0f81; // Rosa (Tailwind Pink-500)
        const gsColor = 0x267a12;  // Verde (Tailwind Green-500)

        // Novas Cores Mais Claras (Ao Clicar)
        const satSelectedColor = 0xfbcfe8; // Rosa Claro (Tailwind Pink-200)
        const gsSelectedColor = 0xbbf7d0;  // Verde Claro (Tailwind Green-200)

        const createMaterial = (color) => new THREE.MeshStandardMaterial({
            color: color,
            metalness: 0.1,
            roughness: 0.3,
            emissive: color,
            emissiveIntensity: 0.2
        });

        this.sats = [
            new THREE.Mesh(groundStationGeometry, createMaterial(gsColor)),
            new THREE.Mesh(satGeometry2u, createMaterial(satColor)), 
            new THREE.Mesh(satGeometry1u, createMaterial(satColor)), 
            new THREE.Mesh(satGeometry1u, createMaterial(satColor))  
        ];

        // Mapeamento de dados e Criação das Bordas
        const nodeNames = ['Estação Solo', 'Lelia', 'Beatriz', 'Carolina'];
        const nodeTypes = ['Ground Station', 'CubeSat-2U', 'CubeSat-1U', 'CubeSat-1U'];

        this.sats.forEach((sat, index) => {
            const isGS = index === 0;
            // Guarda dados no objeto para serem usados pela label HTML
            sat.userData = { 
                id: `node-${index}`, 
                name: nodeNames[index],
                type: nodeTypes[index],
                originalColor: index === 0 ? gsColor : satColor,
                status: 'ON',
                originalColor: isGS ? gsColor : satColor,
                selectedColor: isGS ? gsSelectedColor : satSelectedColor
            };

            // Cria as arestas (bordas brancas)
            const edges = new THREE.EdgesGeometry(sat.geometry);
            const outline = new THREE.LineSegments(
                edges, 
                new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 })
            );
            outline.visible = false; // Esconde inicialmente
            
            sat.add(outline); // Anexa a borda ao satélite
            sat.userData.outline = outline; // Salva a referência

            this.group.add(sat);
        });

        this.linkMaterial = new THREE.LineBasicMaterial({ 
            color: 0xffffff, 
            transparent: true, 
            opacity: 0.8 
        });
    }

    setupInteraction() {
        // Evento de passar o mouse (Hover)
        this.canvasContainer.addEventListener('mousemove', (event) => {
            const rect = this.renderer.domElement.getBoundingClientRect();
            
            // Converte a posição do mouse para o espaço normalizado do Three.js
            this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            // Posição em pixels para mover a label do HTML
            const labelX = event.clientX - rect.left + 15;
            const labelY = event.clientY - rect.top + 15;

            this.raycaster.setFromCamera(this.mouse, this.camera);
            
            // CORREÇÃO: Passar "false" para ignorar os filhos (a borda branca) na colisão
            const intersects = this.raycaster.intersectObjects(this.sats, false);

            if (intersects.length > 0) {
                const object = intersects[0].object;
                
                // Se entrou num objeto diferente
                if (this.hoveredNode !== object) {
                    if (this.hoveredNode) this.hoveredNode.userData.outline.visible = false;
                    
                    this.hoveredNode = object;
                    this.hoveredNode.userData.outline.visible = true; // Mostra a borda branca
                    
                    // Atualiza o texto da label HTML
                    this.tooltip.style.display = 'block';
                    this.tooltip.innerHTML = `
                        <strong style="color: #af2468;">${object.userData.name}</strong><br>
                        Tipo: ${object.userData.type}<br>
                        Link: ${object.userData.status}
                    `;
                }

                // Move a label acompanhando o cursor
                this.tooltip.style.left = `${labelX}px`;
                this.tooltip.style.top = `${labelY}px`;
                this.canvasContainer.style.cursor = 'pointer';

            } else {
                // Se não está em cima de nenhum objeto
                if (this.hoveredNode) {
                    this.hoveredNode.userData.outline.visible = false;
                    this.hoveredNode = null;
                    this.tooltip.style.display = 'none';
                    this.canvasContainer.style.cursor = 'default';
                }
            }
        });

        // Evento de Clique isolado para maior precisão
        this.canvasContainer.addEventListener('click', (event) => {
            const rect = this.renderer.domElement.getBoundingClientRect();
            this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.camera);
            
            // CORREÇÃO: Ignorar recursividade aqui também
            const intersects = this.raycaster.intersectObjects(this.sats, false);

            if (intersects.length > 0) {
                this.toggleSelection(intersects[0].object);
            }
        });
    }

    toggleSelection(object) {
        const index = this.selectedNodes.indexOf(object);

        if (index > -1) {
            this.selectedNodes.splice(index, 1);
            object.material.color.setHex(object.userData.originalColor);
        } else {
            this.selectedNodes.push(object);
            object.material.color.setHex(object.userData.selectedColor); // Muda cor ao clicar
        }

        this.rebuildLines();
    }

    rebuildLines() {
        this.dynamicLines.forEach(line => this.group.remove(line));
        this.dynamicLines = [];

        if (this.selectedNodes.length < 2) return;

        for (let i = 0; i < this.selectedNodes.length; i++) {
            for (let j = i + 1; j < this.selectedNodes.length; j++) {
                const geometry = new THREE.BufferGeometry().setFromPoints([
                    this.selectedNodes[i].position,
                    this.selectedNodes[j].position
                ]);
                const line = new THREE.Line(geometry, this.linkMaterial);
                
                line.userData = { nodeA: this.selectedNodes[i], nodeB: this.selectedNodes[j] };
                
                this.dynamicLines.push(line);
                this.group.add(line);
            }
        }
    }

    updateLines() {
        this.dynamicLines.forEach(line => {
            const positions = line.geometry.attributes.position.array;
            const posA = line.userData.nodeA.position;
            const posB = line.userData.nodeB.position;

            positions[0] = posA.x; positions[1] = posA.y; positions[2] = posA.z;
            positions[3] = posB.x; positions[4] = posB.y; positions[5] = posB.z;

            line.geometry.attributes.position.needsUpdate = true;
        });
    }

    update(newData) {
        super.update(newData);
        if (!newData) return;

        const d12 = Number(newData.dw1000_d12 ?? newData.d12) || 0;
        const d23 = Number(newData.dw1000_d23 ?? newData.d23) || 0;
        const d13 = Number(newData.dw1000_d13 ?? newData.d13) || 0;
        const dA1 = Number(newData.dw1000_dA1 ?? newData.dA1) || 0;
        const dA2 = Number(newData.dw1000_dA2 ?? newData.dA2) || 0;
        const dA3 = Number(newData.dw1000_dA3 ?? newData.dA3) || 0;

        this.sats[0].position.set(0, 0, 0);
        this.sats[1].position.set(dA1, 0, 0); 
        this.sats[2].position.set(d12, 0, dA2);

        const x3 = (d12 ** 2 + d13 ** 2 - d23 ** 2) / (2 * d12 || 1);
        const y3 = Math.sqrt(Math.max(0, d13 ** 2 - x3 ** 2));
        this.sats[3].position.set(x3, y3, dA3);

        // Condiciona o ajuste da câmera ao estado do botão
        if (this.isAutoZoomEnabled) {
            this.adjustCameraZoom();
        }
        
        this.hud.innerHTML = `
            GS-S1: ${dA1.toFixed(1)}m | S1-S2: ${d12.toFixed(1)}m<br>
            GS-S2: ${dA2.toFixed(1)}m | S2-S3: ${d23.toFixed(1)}m<br>
            GS-S3: ${dA3.toFixed(1)}m | S3-S1: ${d13.toFixed(1)}m
        `;
    }

    adjustCameraZoom() {
        const box = new THREE.Box3().setFromObject(this.group);
        const center = new THREE.Vector3();
        box.getCenter(center);
        
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z, 20);

        const fov = this.camera.fov * (Math.PI / 180);
        let targetDistance = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.8;

        this.controls.target.copy(center);

        const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
        this.camera.position.copy(center).add(dir.multiplyScalar(Math.max(targetDistance, 50)));
    }

    observeResize() {
        const resizeObserver = new ResizeObserver(() => {
            const width = this.canvasContainer.clientWidth;
            const height = this.canvasContainer.clientHeight;
            if (width === 0 || height === 0) return;

            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(width, height);
        });
        resizeObserver.observe(this.canvasContainer);
    }

    cleanup() {
        this.isRunning = false;
        this.renderer.dispose();
        super.cleanup();
    }
}

registerWidgetType('constellation', ConstellationWidget);
export default ConstellationWidget;