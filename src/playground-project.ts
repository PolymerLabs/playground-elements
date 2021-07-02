/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {
  LitElement,
  html,
  css,
  customElement,
  property,
  query,
  PropertyValues,
  internalProperty,
} from 'lit-element';
import {wrap, Remote, proxy} from 'comlink';

import {
  SampleFile,
  ServiceWorkerAPI,
  ProjectManifest,
  PlaygroundMessage,
  TypeScriptWorkerAPI,
  CONFIGURE_PROXY,
  CONNECT_PROJECT_TO_SW,
  ACKNOWLEDGE_SW_CONNECTION,
  ModuleImportMap,
  HttpError,
} from './shared/worker-api.js';
import {
  getRandomString,
  endWithSlash,
  forceSkypackRawMode,
} from './shared/util.js';
import {version} from './internal/version.js';
import {Deferred} from './shared/deferred.js';
import {PlaygroundBuild} from './internal/build.js';

import type {Diagnostic} from 'vscode-languageserver';

// Each <playground-project> has a unique session ID used to scope requests from
// the preview iframes.
const sessions = new Set<string>();
const generateUniqueSessionId = (): string => {
  let sessionId;
  do {
    sessionId = getRandomString();
  } while (sessions.has(sessionId));
  sessions.add(sessionId);
  return sessionId;
};

/**
 * Coordinates <playground-file-editor> and <playground-preview> elements.
 */
@customElement('playground-project')
export class PlaygroundProject extends LitElement {
  /**
   * A document-relative path to a project configuration file.
   *
   * When both `projectSrc` and `files` are set, the one set most recently wins.
   * Slotted children win only if both `projectSrc` and `files` are undefined
   */
  @property({attribute: 'project-src', hasChanged: () => false})
  get projectSrc(): string | undefined {
    if (this._source.type === 'url') {
      return this._source.url;
    }
    return undefined;
  }

  set projectSrc(url: string | undefined) {
    if (url) {
      if (this._source.type !== 'url' || this._source.url !== url) {
        this._source = {type: 'url', url};
      }
    } else if (this._source.type === 'url') {
      this._source = {type: 'none'};
    }
  }

  /**
   * Get or set the project config.
   *
   * When both `projectSrc` and `config` are set, the one set most recently
   * wins. Slotted children win only if both `projectSrc` and `config` are
   * undefined.
   */
  @property({attribute: false, hasChanged: () => false})
  get config(): ProjectManifest | undefined {
    // Note this is declared a @property only to capture properties set before
    // upgrade. Attribute reflection and update lifecycle disabled because they
    // are not needed in this case.
    return {
      files: Object.fromEntries(
        (this._files ?? []).map((file) => [
          file.name,
          {
            ...file,
            name: undefined,
          },
        ])
      ),
      importMap: this._validImportMap,
    };
  }
  set config(config: ProjectManifest | undefined) {
    if (config) {
      this._source = {type: 'direct', config};
    } else if (this._source.type === 'direct') {
      this._source = {type: 'none'};
    }
  }

  get files(): SampleFile[] | undefined {
    return this._files;
  }

  /**
   * This property is used to settle which of the multiple ways a project can be
   * specified was set most recently.
   */
  @internalProperty()
  private _source:
    | {
        type: 'none';
      }
    | {
        type: 'direct';
        config: ProjectManifest;
      }
    | {
        type: 'url';
        url: string;
      }
    | {
        type: 'slot';
        files: SampleFile[];
        importMap: ModuleImportMap;
      } = {type: 'none'};

  /**
   * Base URL for script execution sandbox.
   *
   * It is highly advised to change this property to a URL on a separate origin
   * which has no privileges to perform sensitive actions or access sensitive
   * data. This is because this element will execute arbitrary JavaScript, and
   * does not have the ability to sanitize or sandbox it.
   *
   * This URL must host the following files from the playground-elements
   * package:
   *   1. playground-service-worker.js
   *   2. playground-service-worker-proxy.html
   *
   * Defaults to the directory containing the script that defines this element
   * on the same origin (typically something like
   * "/node_modules/playground-elements/").
   */
  @property({attribute: 'sandbox-base-url'})
  sandboxBaseUrl = `https://unpkg.com/playground-elements@${version}/`;

  /**
   * The service worker scope to register on
   */
  // TODO: generate this?
  @property({attribute: 'sandbox-scope'})
  sandboxScope = 'playground-projects/';

  private _build?: PlaygroundBuild;

  /**
   * Map from filename to array of Language Server Protocol diagnostics
   * resulting from the latest compilation.
   */
  get diagnostics(): Map<string, Diagnostic[]> | undefined {
    return this._build?.diagnostics;
  }

  /**
   * A unique identifier for this instance so the service worker can keep an
   * independent cache of files for it.
   */
  private readonly _sessionId: string = generateUniqueSessionId();

  private _files?: SampleFile[];

  @internalProperty()
  private _serviceWorkerAPI?: Remote<ServiceWorkerAPI>;

  private _deferredTypeScriptWorkerApi = new Deferred<
    Remote<TypeScriptWorkerAPI>
  >();

  private _validImportMap: ModuleImportMap = {};

  private set _importMap(importMap: ModuleImportMap) {
    const errors = validateImportMap(importMap);
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(error);
      }
      this._validImportMap = {};
    } else {
      this._validImportMap = importMap;
    }
  }

  private get _importMap(): ModuleImportMap {
    return this._validImportMap;
  }

  @query('slot')
  private _slot!: HTMLSlotElement;

  @query('iframe')
  private _iframe!: HTMLIFrameElement;

  private get _normalizedSandboxBaseUrl() {
    const url = new URL(this.sandboxBaseUrl, document.location.href);
    url.pathname = endWithSlash(url.pathname);
    return url;
  }

  get baseUrl() {
    // Make sure that we've connected to the Service Worker and loaded the
    // project files before generating the preview URL. This ensures that there
    // are files to load when the iframe navigates to the URL.
    if (this._serviceWorkerAPI === undefined || this._files === undefined) {
      return undefined;
    }
    // TODO (justinfagnani): lookup URL to show from project config
    const indexUrl = new URL(
      `${endWithSlash(this.sandboxScope)}${this._sessionId}/`,
      this._normalizedSandboxBaseUrl
    );
    return indexUrl.href;
  }

  private get _serviceWorkerProxyIframeUrl() {
    // We include the session ID as a query parameter so that the service worker
    // can figure out which proxy client goes with which session. We use an
    // #anchor instead of a ?queryParam because unpkg.com strips all
    // ?queryParams.
    return new URL(
      `playground-service-worker-proxy.html#playground-session-id=${this._sessionId}`,
      this._normalizedSandboxBaseUrl
    ).href;
  }

  static styles = css`
    iframe {
      display: none;
    }
  `;

  async update(changedProperties: PropertyValues) {
    if (changedProperties.has('_source')) {
      this._loadProjectFromSource();
    }
    if (
      changedProperties.has('sandboxScope') ||
      changedProperties.has('sandboxBaseUrl') ||
      changedProperties.has('_serviceWorkerAPI')
    ) {
      this.dispatchEvent(new CustomEvent('urlChanged'));
    }
    super.update(changedProperties);
  }

  private async _loadProjectFromSource() {
    const source = this._source;
    switch (source.type) {
      case 'none':
        this._files = undefined;
        this._importMap = {};
        break;
      case 'direct':
        {
          const {files, importMap} = await expandProjectConfig(
            source.config,
            document.baseURI
          );
          // Note the source could have changed while fetching, hence the
          // double-check here.
          if (source !== this._source) {
            return;
          }
          this._files = files;
          this._importMap = importMap;
        }
        break;
      case 'slot':
        this._files = source.files;
        this._importMap = source.importMap;
        break;
      case 'url':
        {
          const {files, importMap} = await fetchProjectConfig(
            new URL(source.url, document.baseURI).href
          );
          // Note the source could have changed while fetching, hence the
          // double-check here.
          if (source !== this._source) {
            return;
          }
          this._files = files;
          this._importMap = importMap;
        }
        break;
      default:
        source as void; // Exhaustive check.
        break;
    }
    this.dispatchEvent(new CustomEvent('filesChanged'));
    this.save();
  }

  render() {
    return html`
      <slot @slotchange=${this._slotChange}></slot>
      <iframe
        src=${this._serviceWorkerProxyIframeUrl}
        @load=${this._onServiceWorkerProxyIframeLoad}
      ></iframe>
    `;
  }

  private _slotChange(_e: Event) {
    const {type} = this._source;
    if (type !== 'none' && type !== 'slot') {
      // It's a little tricky to do "most recent wins" with slots, because the
      // slotchange event will always fire after the first render, giving the
      // illusion that it was set after the other methods. We could do some
      // extra book-keeping to make this work, but it doesn't seem worth the
      // complexity, because it should be very rare to [1] set a `projectSrc` or
      // `files`, and then [2] slot some new children.
      return;
    }
    const files: SampleFile[] = [];
    let importMap: ModuleImportMap | undefined = undefined;
    for (const s of this._slot.assignedElements({flatten: true})) {
      const typeAttr = s.getAttribute('type');
      if (!typeAttr?.startsWith('sample/')) {
        continue;
      }
      const fileType = typeAttr.substring('sample/'.length);
      // TODO (justinfagnani): better entity unescaping
      let content = s.textContent!.replace('&lt;', '<');
      if (!s.hasAttribute('preserve-whitespace')) {
        content = outdent(content);
      }

      if (fileType === 'importmap') {
        try {
          importMap = JSON.parse(content) as ModuleImportMap;
        } catch {
          console.error('Invalid import map JSON', s);
        }
      } else {
        const name = s.getAttribute('filename');
        if (!name) {
          continue;
        }
        // Note "" is an invalid label.
        const label = s.getAttribute('label') || undefined;
        const contentType = typeEnumToMimeType(fileType);
        files.push({
          name,
          label,
          hidden: s.hasAttribute('hidden'),
          content,
          contentType,
        });
      }
    }
    if (files.length > 0 || importMap !== undefined) {
      this._source = {type: 'slot', files, importMap: importMap ?? {}};
    }
  }

  async firstUpdated() {
    const typescriptWorkerScriptUrl = forceSkypackRawMode(
      new URL('./playground-typescript-worker.js', import.meta.url)
    );
    let worker: Worker;
    if (typescriptWorkerScriptUrl.origin === window.location.origin) {
      // Easy case.
      worker = new Worker(typescriptWorkerScriptUrl);
    } else {
      // If the worker script is different-origin, we need to fetch it ourselves
      // and create a blob URL.
      const resp = await fetch(typescriptWorkerScriptUrl.href);
      const text = await resp.text();
      const blobUrl = URL.createObjectURL(
        new Blob([text], {type: 'application/javascript'})
      );
      worker = new Worker(blobUrl);
      URL.revokeObjectURL(blobUrl);
    }
    this._deferredTypeScriptWorkerApi.resolve(
      wrap<TypeScriptWorkerAPI>(worker)
    );
  }

  private _onServiceWorkerProxyIframeLoad() {
    // This iframe exists to proxy messages between this project and the service
    // worker, because the service worker may be running on a different origin
    // for security.
    const iframeWindow = this._iframe.contentWindow;
    if (!iframeWindow) {
      throw new Error(
        'Unexpected internal error: ' +
          '<playground-project> service worker proxy iframe had no contentWindow'
      );
    }
    // This channel is persistent, and is only used to receieve new service
    // worker channel ports from the proxy iframe. Note we can get new service
    // worker ports at any time from the proxy, when the service worker updates.
    const {port1, port2} = new MessageChannel();
    port1.addEventListener(
      'message',
      (event: MessageEvent<PlaygroundMessage>) => {
        if (event.data.type === CONNECT_PROJECT_TO_SW) {
          this._onNewServiceWorkerPort(event.data.port);
        }
      }
    );
    port1.start();
    const configureMessage: PlaygroundMessage = {
      type: CONFIGURE_PROXY,
      url: 'playground-service-worker.js',
      scope: this.sandboxScope,
      port: port2,
    };
    // We could constrain targetOrigin to
    // `this._normalizedSandboxBaseUrl.origin`, but unclear if that provides any
    // security benefit, and would add the limitation that the sandboxBaseUrl
    // can't redirect to another origin.
    iframeWindow.postMessage(configureMessage, '*', [configureMessage.port]);
  }

  private _onNewServiceWorkerPort(port: MessagePort) {
    const onMessage = (e: MessageEvent<PlaygroundMessage>) => {
      if (e.data.type === ACKNOWLEDGE_SW_CONNECTION) {
        port.removeEventListener('message', onMessage);
        this._serviceWorkerAPI = wrap<ServiceWorkerAPI>(port);
        this._serviceWorkerAPI.setFileAPI(
          proxy({
            getFile: (name: string) => this._getFile(name),
          }),
          this._sessionId
        );
      }
    };
    port.addEventListener('message', onMessage);
    port.start();
  }

  private async _getFile(name: string): Promise<SampleFile | HttpError> {
    if (this._build === undefined) {
      return {
        status: /* Service Unavailable */ 503,
        body: 'Playground build not started',
      };
    }
    return this._build.getFile(name);
  }

  /**
   * Build this project immediately, cancelling any previous build.
   */
  async save() {
    this._build?.cancel();
    const build = new PlaygroundBuild(() => {
      this.dispatchEvent(new CustomEvent('diagnosticsChanged'));
    });
    this._build = build;
    this.dispatchEvent(new CustomEvent('compileStart'));
    const workerApi = await this._deferredTypeScriptWorkerApi.promise;
    if (build.state() !== 'active') {
      return;
    }
    workerApi.compileProject(
      this._files ?? [],
      this._importMap,
      proxy((result) => build.onOutput(result))
    );
    await build.stateChange;
    if (build.state() !== 'done') {
      return;
    }
    this.dispatchEvent(new CustomEvent('compileDone'));
  }

  private lastSave = Promise.resolve();
  private savePending = false;
  /**
   * A simple debouncer that aims for maximal responsiveness when compiles are fast.
   *
   * There is no meaning to when the returned promise resolves.
   */
  async saveDebounced() {
    if (this.savePending) {
      return;
    }
    this.savePending = true;
    await this.lastSave;
    this.savePending = false;
    this.lastSave = this.save();
  }

  isValidNewFilename(name: string): boolean {
    return (
      !!name && !!this._files && !this._files.some((file) => file.name === name)
    );
  }

  addFile(name: string) {
    if (!this._files) {
      return;
    }
    if (!this.isValidNewFilename(name)) {
      return;
    }
    this._files = [
      ...this._files,
      {name, content: '', contentType: typeFromFilename(name)},
    ];
    this.dispatchEvent(new CustomEvent('filesChanged'));
    this.save();
  }

  deleteFile(filename: string) {
    this._files = this._files?.filter((file) => file.name !== filename);
    this.dispatchEvent(new CustomEvent('filesChanged'));
    this.save();
  }

  renameFile(oldName: string, newName: string) {
    if (!oldName || !this._files) {
      return;
    }
    if (!this.isValidNewFilename(newName)) {
      return;
    }
    const file = this._files.find((file) => file.name === oldName);
    if (!file) {
      return;
    }
    // TODO(aomarks) Check name is unique;
    file.name = newName;
    file.contentType = typeFromFilename(newName);
    this._files = [...this._files];
    this.dispatchEvent(new CustomEvent('filesChanged'));
    this.save();
  }
}

/**
 * Fetches and expands the given JSON project config URL.
 */
const fetchProjectConfig = async (
  url: string,
  alreadyFetchedFilenames = new Set<string>(),
  alreadyFetchedConfigUrls = new Set<string>()
): Promise<{files: Array<SampleFile>; importMap: ModuleImportMap}> => {
  if (alreadyFetchedConfigUrls.has(url)) {
    throw new Error(
      `Circular project config extends: ${[
        ...alreadyFetchedConfigUrls.values(),
        url,
      ].join(' extends ')}`
    );
  }
  alreadyFetchedConfigUrls.add(url);
  const resp = await fetch(url);
  if (resp.status !== 200) {
    throw new Error(
      `Error ${
        resp.status
      } fetching project config from ${url}: ${await resp.text()}`
    );
  }
  let config: Partial<ProjectManifest>;
  try {
    config = await resp.json();
  } catch (e) {
    throw new Error(
      `Error parsing project config JSON from ${url}: ${e.message}`
    );
  }
  return await expandProjectConfig(
    config,
    url,
    alreadyFetchedFilenames,
    alreadyFetchedConfigUrls
  );
};

/**
 * Expands a partial project config by following its `extends` property, and
 * fetching the content for all files.
 */
const expandProjectConfig = async (
  config: ProjectManifest,
  baseUrl: string,
  alreadyFetchedFilenames = new Set<string>(),
  alreadyFetchedConfigUrls = new Set<string>()
): Promise<{files: Array<SampleFile>; importMap: ModuleImportMap}> => {
  const filePromises: Array<Promise<SampleFile>> = [];
  for (const [filename, info] of Object.entries(config.files ?? {})) {
    // A higher precedence config is already handling this file.
    if (alreadyFetchedFilenames.has(filename)) {
      continue;
    }
    alreadyFetchedFilenames.add(filename);
    if (info.content === undefined) {
      filePromises.push(
        (async () => {
          const resp = await fetch(new URL(filename, baseUrl).href);
          return {
            ...info,
            name: filename,
            content: await resp.text(),
            contentType: resp.headers.get('Content-Type') ?? 'text/plain',
          };
        })()
      );
    } else {
      filePromises.push(
        Promise.resolve({
          ...info,
          name: filename,
          content: info.content ?? '',
          contentType: typeFromFilename(filename) ?? 'text/plain',
        })
      );
    }
  }

  // Start extends config fetch before we block on file fetches.
  const extendsConfigPromise = config.extends
    ? fetchProjectConfig(
        new URL(config.extends, baseUrl).href,
        alreadyFetchedFilenames,
        alreadyFetchedConfigUrls
      )
    : undefined;

  const files = await Promise.all(filePromises);
  const importMap = config.importMap ?? {};

  if (extendsConfigPromise) {
    const extendsConfig = await extendsConfigPromise;
    // Parent files go after our own.
    files.push(...extendsConfig.files);
    importMap.imports = {
      ...extendsConfig.importMap?.imports,
      // Our imports take precedence over our parents.
      ...importMap.imports,
    };
  }

  return {files, importMap};
};

const typeFromFilename = (filename: string) => {
  const idx = filename.lastIndexOf('.');
  if (idx === -1 || idx === filename.length - 1) {
    return undefined;
  }
  const extension = filename.slice(idx + 1);
  return typeEnumToMimeType(extension);
};

const typeEnumToMimeType = (type?: string) => {
  if (type === undefined) {
    return;
  }
  switch (type) {
    // TypeScript
    case 'ts':
      return 'video/mp2t';
    case 'js':
      return 'application/javascript; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'html':
      return 'text/html; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
  }
  return undefined;
};

/**
 * Validate an import map configuration (https://wicg.github.io/import-maps/).
 * Returns an array of errors. If empty, the import map is valid.
 */
const validateImportMap = (importMap: unknown): string[] => {
  const errors = [];

  if (typeof importMap !== 'object' || importMap === null) {
    errors.push(
      `Import map is invalid because it must be an object,` +
        ` but it was ${importMap === null ? 'null' : typeof importMap}.`
    );
    return errors;
  }

  const invalidKeys = Object.keys(importMap).filter((key) => key !== 'imports');
  if (invalidKeys.length > 0) {
    errors.push(
      `Invalid import map properties: ${[...invalidKeys].join(', ')}.` +
        ` Only "imports" are currently supported.`
    );
  }
  const imports = (importMap as {imports: unknown}).imports;
  if (imports === undefined) {
    return errors;
  }

  if (typeof imports !== 'object' || imports === null) {
    errors.push(
      `Import map "imports" property is invalid` +
        ` because it must be an object,` +
        ` but it was ${imports === null ? 'null' : typeof imports}.`
    );
    return errors;
  }

  for (const [specifierKey, resolutionResult] of Object.entries(imports)) {
    if (typeof resolutionResult !== 'string') {
      errors.push(
        `Import map key "${specifierKey}" is invalid because` +
          ` address must be a string, but was` +
          ` ${resolutionResult === null ? 'null' : typeof resolutionResult}`
      );
      continue;
    }
    if (specifierKey.endsWith('/') && !resolutionResult.endsWith('/')) {
      errors.push(
        `Import map key "${specifierKey}" is invalid because` +
          ` address "${resolutionResult}" must end in a forward-slash.`
      );
    }
    try {
      new URL(resolutionResult, import.meta.url);
    } catch {
      errors.push(
        `Import map key "${specifierKey}" is invalid because` +
          ` address "${resolutionResult}" is not a valid URL.`
      );
    }
  }

  return errors;
};

declare global {
  interface HTMLElementTagNameMap {
    'playground-project': PlaygroundProject;
  }
}

/**
 * Trim shared leading whitespace from all lines, and remove empty
 * leading/trailing lines.
 */
const outdent = (str: string): string => {
  // Remove leading/trailing empty lines (we don't use trim() because we don't
  // want to remove leading whitespace on the first content line).
  str = str.replace(/(^[\n\s]*\n)|(\n[\n\s]*$)/g, '');
  let shortestIndent;
  for (const line of str.split(/\n/g)) {
    const indent = line.match(/^\s*/)![0].length;
    if (shortestIndent === undefined || indent < shortestIndent) {
      shortestIndent = indent;
    }
  }
  return str.replace(RegExp(`^\\s{${shortestIndent ?? 0}}`, 'gm'), '');
};
