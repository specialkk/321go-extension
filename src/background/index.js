import 'chrome-extension-async';

import { getTab, getPortSubject } from '../utils';
import { Client } from './client';
import { Observable, concat } from 'rxjs';
import { distinctUntilKeyChanged, switchMap } from 'rxjs/operators';

const clients = new Map();

function createTabClient(tabId) {
  const client = new Client(tabId);
  clients.set(tabId, client);
  return client;
}

/**
 * onConnect handler for new content scripts.
 * If the tab disconnects the port (from navigating or refreshing the page),
 * a new content script is injected if the tab still exists and is joined to a room.
 * @param {Port} port
 */
function initTabPort(port) {
  const { tab } = port.sender;
  // create a client for each tab
  const client = clients.get(tab.id);
  client.port = getPortSubject(port);
  client.port.subscribe(message => client.socket.next(message), null, async () => {
    client.port = null;
    const newTab = await getTab(client.tabId);
    if (newTab && client.room.value.id) {
      await client.execContentScript();
    }
  });
  client.observeMedia();
}

/**
 * onConnect handler for new popup windows.
 * @param {Port} port
 */
function initPopupPort(port) {
  const roomMap = {};
  for (const [tabId, client] of clients) {
    roomMap[tabId] = client.room.value.id;
  }
  const portSubject = getPortSubject(port);
  portSubject.pipe(
    distinctUntilKeyChanged('tab'),
    switchMap((message) => Observable.create(() => {
      const client = clients.get(message.tab) || createTabClient(message.tab);
      const subscription = client.popup.destination.subscribe(portSubject);
      subscription.add(concat(
        [message],
        portSubject,
      ).subscribe(value => client.popup.source.next(value)));
      return () => subscription.unsubscribe();
    })),
  ).subscribe();
  port.postMessage(roomMap);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const client = clients.get(tabId);
  if (client) {
    client.room.next({ id: null });
    client.room.complete();
    clients.delete(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const client = clients.get(tabId);
  if (!client) return;
  client.updateBrowserActionPermissionStatus();
  if (changeInfo.url !== client.room.value.href) {
    client.socket.next({ type: 'URL', href: changeInfo.url });
  }
});

// wait for things to connect to the background script
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender.id !== chrome.runtime.id) {
    port.disconnect();
  } else if (port.sender.tab) {
    initTabPort(port);
  } else {
    initPopupPort(port);
  }
});
