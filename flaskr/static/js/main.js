import BaseWidget from './widgets/BaseWidget.js';
import MapWidget from './widgets/MapWidget.js';
import terminalWidget from './widgets/terminalWidget.js';


//Websocket
const socket = io();
let current_data = {};
const widget_list = [];

socket.on('new_data', (data) => {
    console.log(data);  
    Object.assign(current_data,data);
    updateWidgets();
});

//Funcionalidade de butoes
const createNewTestButton = document.getElementById("testButton")
createNewTestButton.addEventListener('click', () => {

  const widget = new BaseWidget("testWidget","workspace");
  widget_list.push(widget);
  widget.render();
});

const createRawDataButton = document.getElementById("rawDataButton")
createRawDataButton.addEventListener('click', () => {

  const widget = new terminalWidget("Terminal","workspace",current_data);
  widget_list.push(widget);
  widget.render();
});

const createNewMapButton = document.getElementById("mapButton")
createNewMapButton.addEventListener('click', () => {

  const widget = new MapWidget("Map View","workspace");
  widget_list.push(widget);
  widget.render();
});


//Lógica de updates dos widgets

function updateWidgets(currentTime) {


    // Atualiza todos os widgets da tela
    for (let widget of widget_list) {
        widget.update();
    }

}

document.addEventListener('DOMContentLoaded', () => {
    



});