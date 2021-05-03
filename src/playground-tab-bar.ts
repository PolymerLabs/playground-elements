/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {
  html,
  customElement,
  css,
  property,
  internalProperty,
  query,
  PropertyValues,
} from 'lit-element';
import {nothing} from 'lit-html';

import '@shoelace-style/shoelace/dist/components/tab-group/tab-group.js';
import '@shoelace-style/shoelace/dist/components/tab/tab.js';
import {shoelaceBaseTheme} from './lib/shoelace-base-theme.js';
import type SlTabGroup from '@shoelace-style/shoelace/dist/components/tab-group/tab-group.js';
import type SlTab from '@shoelace-style/shoelace/dist/components/tab/tab.js';

import '@material/mwc-icon-button';

import './playground-code-editor.js';
import './playground-file-system-controls.js';
import {PlaygroundFileEditor} from './playground-file-editor.js';
import {PlaygroundFileSystemControls} from './playground-file-system-controls.js';
import {PlaygroundProject} from './playground-project.js';
import {PlaygroundConnectedElement} from './playground-connected-element.js';

/**
 * A horizontal bar of tabs for switching between playground files, with
 * optional controls for create/delete/rename.
 */
@customElement('playground-tab-bar')
export class PlaygroundTabBar extends PlaygroundConnectedElement {
  static styles = [
    shoelaceBaseTheme,
    css`
      :host {
        display: flex;
        height: var(--playground-bar-height, 40px);
        background: var(--playground-tab-bar-background, #eaeaea);
        flex-direction: row;
        align-items: center;
        --mdc-theme-primary: var(--playground-highlight-color, #6200ee);
      }

      mwc-tab-bar {
        --mdc-tab-text-label-color-default: var(
          --playground-tab-bar-foreground-color,
          #000
        );
        --mdc-typography-button-text-transform: none;
        --mdc-typography-button-font-weight: normal;
        --mdc-typography-button-font-size: var(
          --playground-tab-bar-font-size,
          0.85em
        );
        --mdc-typography-button-letter-spacing: normal;
      }

      mwc-icon-button {
        color: var(--playground-tab-bar-foreground-color);
      }

      sl-tab-group,
      sl-tab-group::part(base),
      sl-tab,
      sl-tab::part(base) {
        height: var(--playground-bar-height, 40px);
      }

      .add-file-button {
        margin: 0 4px;
        opacity: 70%;
        --mdc-icon-button-size: 24px;
        --mdc-icon-size: 24px;
      }

      .add-file-button:hover {
        opacity: 100%;
      }
    `,
  ];

  /**
   * Allow the user to add, remove, and rename files in the project's virtual
   * filesystem. Disabled by default.
   */
  @property({type: Boolean, attribute: 'editable-file-system'})
  editableFileSystem = false;

  @internalProperty()
  private _activeFileName = '';

  @internalProperty()
  private _activeFileIndex = 0;

  @query('sl-tab-group')
  private _tabGroup?: SlTabGroup;

  @query('playground-file-system-controls')
  private _fileSystemControls?: PlaygroundFileSystemControls;

  /**
   * The actual `<playground-file-editor>` node, determined by the `editor`
   * property.
   */
  @internalProperty()
  private _editor?: PlaygroundFileEditor;

  /**
   * The editor that this tab bar controls. Either the
   * `<playground-file-editor>` node itself, or its `id` in the host scope.
   */
  @property()
  set editor(elementOrId: PlaygroundFileEditor | string) {
    if (typeof elementOrId === 'string') {
      // Defer querying the host to a rAF because if the host renders this
      // element before the one we're querying for, it might not quite exist
      // yet.
      requestAnimationFrame(() => {
        const root = this.getRootNode() as ShadowRoot | Document;
        this._editor =
          (root.getElementById(elementOrId) as PlaygroundFileEditor | null) ??
          undefined;
      });
    } else {
      this._editor = elementOrId;
    }
  }

  private get _visibleFiles() {
    return (this._project?.files ?? []).filter(({hidden}) => !hidden);
  }

  update(changedProperties: PropertyValues) {
    if (changedProperties.has('_project')) {
      const oldProject = changedProperties.get('_project') as PlaygroundProject;
      if (oldProject) {
        oldProject.removeEventListener(
          'filesChanged',
          this._onProjectFilesChanged
        );
      }
      if (this._project) {
        this._onProjectFilesChanged();
        this._project.addEventListener(
          'filesChanged',
          this._onProjectFilesChanged
        );
      }
    }
    if (changedProperties.has('_activeFileName') && this._editor) {
      this._editor.filename = this._activeFileName;
      this._setNewActiveFile();
    }
    super.update(changedProperties);
  }

  render() {
    return html`
      <sl-tab-group @sl-tab-show=${this._onTabActivated}>
        ${this._visibleFiles.map(
          ({name, label}) =>
            html`<sl-tab slot="nav" panel=${name}
              >${label || name}
              ${this.editableFileSystem
                ? html` <mwc-icon-button
                    label="File menu"
                    class="menu-button"
                    @click=${this._onClickMenuButton}
                  >
                    <!-- Source: https://material.io/resources/icons/?icon=menu&style=baseline -->
                    <svg viewBox="0 0 24 24" fill="currentcolor">
                      <path
                        d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"
                      />
                    </svg>
                  </mwc-icon-button>`
                : nothing}
            </sl-tab>`
        )}
      </sl-tab-group>

      ${this.editableFileSystem
        ? html`
            <mwc-icon-button
              class="add-file-button"
              label="New file"
              @click=${this._onClickAddFile}
            >
              <!-- Source: https://material.io/resources/icons/?icon=add&style=baseline -->
              <svg fill="currentcolor">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
              </svg>
            </mwc-icon-button>

            <playground-file-system-controls
              .project=${this._project}
              @newFile=${this._onNewFile}
            >
            </playground-file-system-controls>
          `
        : nothing}
    `;
  }

  async updated() {
    // TODO(aomarks) There still seems to be a timing bug where the mwc-tab-bar
    // activeIndex property doesn't initially take. This hack pokes the bar
    // after render to make sure the active tab is really selected.
    if (!this._tabGroup) {
      return;
    }
    await this._tabGroup.updateComplete;
    // this._tabGroup.activeIndex = -1;
    // this._tabGroup.activeIndex = this._activeFileIndex;
  }

  private _onProjectFilesChanged = () => {
    this._setNewActiveFile();
    this.requestUpdate();
  };

  _onTabActivated(event: CustomEvent<{name: string}>) {
    const filename = event.detail.name;
    if (filename !== this._activeFileName) {
      this._activeFileName = filename;
      this._activeFileIndex = this._visibleFiles.findIndex(
        (file) => file.name === filename
      );
    }
  }

  private _onClickAddFile(event: Event) {
    // Don't trigger the menu's close-on-click-outside handler.
    event.stopPropagation();
    const controls = this._fileSystemControls;
    if (!controls) {
      return;
    }
    controls.state = 'newfile';
    controls.anchorElement = event.target as HTMLElement;
  }

  private _onNewFile(event: CustomEvent<{filename: string}>) {
    this._activeFileName = event.detail.filename;
    // TODO(aomarks) We should focus the editor here. However,
    // CodeMirror.focus() isn't working for some reason.
  }

  /**
   * Whenever a file is created, deleted, or renamed, figure out what the best
   * new active tab should be.
   */
  private _setNewActiveFile() {
    // Stay on the same filename if it's still around, even though its index
    // might have changed.
    if (this._activeFileName) {
      const index = this._visibleFiles.findIndex(
        (file) => file.name === this._activeFileName
      );
      if (index >= 0) {
        this._activeFileIndex = index;
        return;
      }
    }

    // Stay on the same index, or the nearest one to the left of where we were
    // before.
    for (let i = this._activeFileIndex; i >= 0; i--) {
      const file = this._visibleFiles[i];
      if (file && !file.hidden) {
        this._activeFileName = file.name;
        return;
      }
    }

    // No visible file to display.
    this._activeFileIndex = 0;
    this._activeFileName = '';
  }

  private _onClickMenuButton(event: Event) {
    const controls = this._fileSystemControls;
    if (!controls) {
      return;
    }
    const menuButton = event.target as HTMLElement;
    const tab = menuButton.parentElement as SlTab;
    const fileIndex = this._visibleFiles.findIndex(
      (file) => file.name === tab.panel
    );
    controls.state = 'menu';
    controls.filename = this._visibleFiles[fileIndex].name;
    controls.anchorElement = menuButton;
    // Don't trigger the menu's close-on-click-outside handler.
    event.stopPropagation();
  }
}
