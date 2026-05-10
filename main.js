'use strict';

const utils = require('@iobroker/adapter-core');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const adapterName = require('./package.json').name.split('.').pop();
let adapter;

function startAdapter(options) {
    options = options || {};

    Object.assign(options, {
        name: adapterName,
        ready: () => main(),
    });

    adapter = new utils.Adapter(options);
    return adapter;
}

function getVisDir() {
    const visPackagePath = require.resolve('iobroker.vis/package.json');
    return path.dirname(visPackagePath);
}

function readText(filePath) {
    return fs.readFileSync(filePath).toString();
}

async function readStoredFile(id, fileName) {
    let data;

    try {
        data = await adapter.readFileAsync(id, fileName);
    } catch (_error) {
        return '';
    }

    if (typeof data === 'object' && data && Object.prototype.hasOwnProperty.call(data, 'file')) {
        return data.file ? data.file.toString() : '';
    }

    return data ? data.toString() : '';
}

async function writeStoredFileIfChanged(id, fileName, content) {
    const current = await readStoredFile(id, fileName);
    if (current === content) {
        return false;
    }

    await adapter.writeFileAsync(id, fileName, content);
    return true;
}

async function writeVisPage(visDir, fileName) {
    const config = require(path.join(visDir, 'www', 'js', 'config.js')).config;
    const srcParts = fileName.split('.');
    const ext = srcParts.pop();
    const srcFileName = `${srcParts.join('.')}.src.${ext}`;
    const srcFilePath = path.join(visDir, 'www', srcFileName);
    const targetFilePath = path.join(visDir, 'www', fileName);
    let index;

    if (fs.existsSync(srcFilePath)) {
        index = readText(srcFilePath);
    } else {
        index = readText(targetFilePath);
        fs.writeFileSync(srcFilePath, index);
    }

    index = index.replace(
        '<!--html manifest="cache.manifest" xmlns="http://www.w3.org/1999/html"--><html>',
        '<html manifest="cache.manifest" xmlns="http://www.w3.org/1999/html">'
    );

    const begin = '<!-- ---------------------------------------  DO NOT EDIT INSIDE THIS LINE - BEGIN ------------------------------------------- -->';
    const end = '<!-- ---------------------------------------  DO NOT EDIT INSIDE THIS LINE - END   ------------------------------------------- -->';
    let bigInsert = '';

    for (const widgetSet of config.widgetSets) {
        let name;

        if (typeof widgetSet === 'object') {
            name = `${widgetSet.name}.html`;
        } else {
            name = `${widgetSet}.html`;
        }

        bigInsert += `<!-- --------------${name}--- START -->\n${readText(path.join(visDir, 'www', 'widgets', name))}\n<!-- --------------${name}--- END -->\n`;
    }

    let pos = index.indexOf(begin);
    if (pos === -1) {
        return false;
    }

    const start = index.substring(0, pos + begin.length);
    pos = index.indexOf(end);
    if (pos === -1) {
        return false;
    }

    const tail = index.substring(pos);
    index = `${start}\n${bigInsert}\n${tail}`;

    const changed = await writeStoredFileIfChanged('vis', fileName, index);
    if (changed) {
        fs.writeFileSync(targetFilePath, index);
    }

    return changed;
}

async function updateCacheManifest(visDir) {
    const manifestPath = path.join(visDir, 'www', 'cache.manifest');
    let data = readText(manifestPath);
    const build = data.match(/# dev build ([0-9]+)/);
    const currentBuild = build && build[1] ? parseInt(build[1], 10) : 0;

    data = data.replace(/# dev build [0-9]+/, `# dev build ${currentBuild + 1}`);
    fs.writeFileSync(manifestPath, data);
    await adapter.writeFileAsync('vis', 'cache.manifest', data);
}

function uploadVisWidgets() {
    return new Promise(resolve => {
        const file = path.join(utils.controllerDir, 'iobroker.js');
        const child = childProcess.spawn(process.execPath, [file, 'upload', 'vis', 'widgets']);

        child.stdout.on('data', data => adapter.log.debug(data.toString().replace('\n', '')));
        child.stderr.on('data', data => adapter.log.warn(data.toString().replace('\n', '')));
        child.on('exit', code => resolve(code || 0));
    });
}

async function syncVisFiles() {
    const visDir = getVisDir();
    const syncWidgetSets = require(path.join(visDir, 'lib', 'install.js'));
    let changed = !!syncWidgetSets(false);
    const localConfig = readText(path.join(visDir, 'www', 'js', 'config.js'));

    if (await writeStoredFileIfChanged('vis', 'js/config.js', localConfig)) {
        changed = true;
    }

    const indexChanged = await writeVisPage(visDir, 'index.html');
    const editChanged = await writeVisPage(visDir, 'edit.html');

    if (changed || indexChanged || editChanged) {
        await updateCacheManifest(visDir);
        await uploadVisWidgets();
    }
}

async function main() {
    try {
        await syncVisFiles();
    } catch (error) {
        adapter.log.error(`VIS widget sync failed: ${error.message}`);
    }

    adapter.stop();
}

if (module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
