'use strict';

const { ipcRenderer } = require( "electron" );
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const helper = require('../libs/electron_helper/helper_new.js');
const tools = helper.tools;
const app = helper.app;

let g = {};

// Init
// ###########################################################################

addEventListener("DOMContentLoaded", init);
async function init(){
	g.win = helper.window;
	g.body = document.body;
	g.icon = ut.el('.nui-title-bar .nui-icon-container');
	g.cover = ut.el('.cover');
	window.addEventListener("keydown", onKey);
	ipcRenderer.on('log', (e, data) => {
		console.log(data);
	})
	ut.el('.nui-app .controls .close').addEventListener('click', (e) => { g.win.hide(); })
	g.icon.innerHTML = ut.icon('settings');
	setupWindow(g.win);
	
	ipcRenderer.once('init_data', (e, data) => start(data))
	ipcRenderer.on('reg_log', (e, data) => { console.log(data)})
	ipcRenderer.on('info', renderInfo);
	ipcRenderer.on('command', (e,data) => {
		if(data == 'show'){
			g.win.show();
		}
		if(data == 'hide'){
			g.win.hide();
		}
	});
}

function start(config){
	console.log(config)
	g.config = config;
	g.win.show();
	g.win.toggleDevTools();
}

function setupWindow(){
	g.win.hook_event('blur', handler);
	g.win.hook_event('focus', handler);
	function handler(e, data){
		if(data.type == 'blur'){
			g.body.classList.remove('focus');
		}
		if(data.type == 'focus'){
			g.body.classList.add('focus');
		}
	}
}

function renderInfo(e, data){
	/*ut.killKids(g.cover);
	if(data.cover_src){
		let img = new Image();
		img.src = data.cover_src;
		g.cover.appendChild(img);
	}*/
	console.log(data);
}

async function onKey(e) {
	if (e.keyCode == 76 && e.ctrlKey) {
		g.win.toggleDevTools();
	}
}