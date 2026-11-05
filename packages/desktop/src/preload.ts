import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';

function subscribe<T extends unknown[]>(channel: string, listener: (...args: T) => void) {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as T));
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('davecodeDesktop', {
  chooseProject: () => ipcRenderer.invoke('desktop:choose-project'),
  terminal: {
    open: (request: unknown) => ipcRenderer.invoke('terminal:open', request),
    write: (request: unknown) => ipcRenderer.invoke('terminal:write', request),
    resize: (request: unknown) => ipcRenderer.invoke('terminal:resize', request),
    close: (id: string) => ipcRenderer.invoke('terminal:close', id),
    copy: (text: string) => ipcRenderer.invoke('terminal:copy', text),
    onData: (listener: (id: string, data: string) => void) => subscribe('terminal:data', listener),
    onExit: (listener: (id: string, code: number) => void) => subscribe('terminal:exit', listener),
  },
});
