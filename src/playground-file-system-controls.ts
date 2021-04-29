/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {
  customElement,
  property,
  query,
  html,
  css,
  PropertyValues,
} from 'lit-element';
import {nothing} from 'lit-html';

import '@shoelace-style/shoelace/dist/components/menu/menu.js';
import '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@material/mwc-menu/mwc-menu-surface.js';

import {MenuSurface} from '@material/mwc-menu/mwc-menu-surface.js';
import type SlInput from '@shoelace-style/shoelace/dist/components/input/input.js';
import type SlButton from '@shoelace-style/shoelace/dist/components/button/button.js';
import type SlMenu from '@shoelace-style/shoelace/dist/components/menu/menu.js';
import type SlMenuItem from '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js';

import {PlaygroundConnectedElement} from './playground-connected-element.js';
import {shoelaceBaseTheme} from './lib/shoelace-base-theme.js';

/**
 * Floating controls for creating, deleting, and renaming files in playground
 * virtual file system.
 */
@customElement('playground-file-system-controls')
export class PlaygroundFileSystemControls extends PlaygroundConnectedElement {
  static styles = [
    shoelaceBaseTheme,
    css`
      mwc-menu-surface {
        --mdc-theme-primary: var(
          var(
            --playground-floating-controls-color,
            var(--playground-highlight-color, #6200ee)
          )
        );
      }

      mwc-menu-surface.menu {
        --mdc-typography-subtitle1-font-size: 13px;
        --mdc-list-item-graphic-margin: 14px;
      }

      mwc-menu-surface.rename > .wrapper,
      mwc-menu-surface.newfile > .wrapper {
        padding: 18px;
      }

      sl-input {
        margin-bottom: 20px;
      }
    `,
  ];

  /**
   * The element that these controls will be positioned adjacent to.
   */
  @property({attribute: false})
  anchorElement?: HTMLElement;

  /**
   * The kind of control to display:
   *
   * -  closed: Hidden.
   * -    menu: Menu with "Rename" and "Delete" items.
   * -  rename: Control for renaming an existing file.
   * - newfile: Control for creating a new file.
   */
  @property()
  state: 'closed' | 'menu' | 'rename' | 'newfile' = 'closed';

  /**
   * When state is "menu" or "newfile", the name of the relevant file.
   */
  @property()
  filename?: string;

  @query('mwc-menu-surface')
  private _surface!: MenuSurface;

  @query('.menu-list')
  private _menuList?: SlMenu;

  @query('sl-menu-item:first-of-type')
  private _firstMenuItem?: SlMenuItem;

  @query('.filename-input')
  private _filenameInput?: SlInput;

  @query('.submit-button')
  private _submitButton?: SlButton;

  private _postStateChangeRenderDone = false;

  update(changedProperties: PropertyValues) {
    if (changedProperties.has('state')) {
      this._postStateChangeRenderDone = false;
    }
    super.update(changedProperties);
  }

  render() {
    return html`<mwc-menu-surface
      fixed
      quick
      .open=${this.state !== 'closed'}
      .anchor=${this.anchorElement}
      corner="BOTTOM_START"
      .classList=${this.state}
      @closed=${this._onSurfaceClosed}
      ><div class="wrapper">${this._surfaceContents}</div></mwc-menu-surface
    >`;
  }

  async updated() {
    if (this._postStateChangeRenderDone) {
      return;
    }
    if (this.state === 'menu') {
      // Focus the first item  so that keyboard controls work.
      const menuList = this._menuList;
      if (menuList) {
        await menuList.updateComplete;
        this._firstMenuItem?.focus();
      }
    } else if (this.state === 'rename' || this.state === 'newfile') {
      // Focus the filename input.
      const input = this._filenameInput;
      if (input) {
        await input.updateComplete;
        input.focus();
        if (this.state === 'rename') {
          // Pre-select just the basename (e.g. "foo" in "foo.html"), since
          // users typically don't want to edit the extension.
          input.setSelectionRange(0, input.value.lastIndexOf('.'));
        }
      }
    }
    this._postStateChangeRenderDone = true;
  }

  private get _surfaceContents() {
    switch (this.state) {
      case 'closed':
        return nothing;
      case 'menu':
        return this._menu;
      case 'rename':
        return this._rename;
      case 'newfile':
        return this._newFile;
    }
  }

  private get _menu() {
    return html`
      <sl-menu class="menu-list" @sl-select=${this._onMenuSelect}>
        <sl-menu-item value="rename">
          Rename
          <svg
            slot="prefix"
            viewBox="0 0 24 24"
            height="18"
            width="18"
            fill="currentcolor"
          >
            <path
              d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
            />
          </svg>
        </sl-menu-item>
        <sl-menu-item value="delete">
          Delete
          <svg
            slot="prefix"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="currentcolor"
            shape-rendering="crispEdges"
          >
            <path
              d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
            />
          </svg>
        </sl-menu-item>
      </sl-menu>
    `;
  }

  private get _rename() {
    return html`
      <sl-input
        class="filename-input"
        label="Filename"
        .value=${this.filename || ''}
        @input=${this._onFilenameInputChange}
        @keydown=${this._onFilenameInputKeydown}
      ></sl-input>
      <div class="actions">
        <sl-button outlined @click=${this._onClickCancel}>Cancel</sl-button>
        <sl-button
          type="primary"
          class="submit-button"
          .disabled=${!this._filenameInputValid}
          @click=${this._onSubmitRename}
          >Rename</sl-button
        >
      </div>
    `;
  }

  private get _newFile() {
    return html`
      <sl-input
        class="filename-input"
        label="Filename"
        @input=${this._onFilenameInputChange}
        @keydown=${this._onFilenameInputKeydown}
      ></sl-input>
      <div class="actions">
        <sl-button outlined @click=${this._onClickCancel}>Cancel</sl-button>
        <sl-button
          type="primary"
          class="submit-button"
          .disabled=${!this._filenameInputValid}
          @click=${this._onSubmitNewFile}
          >Create</sl-button
        >
      </div>
    `;
  }

  private _onSurfaceClosed() {
    this.state = 'closed';
  }

  private _onClickCancel() {
    this._surface.close();
  }

  private _onMenuSelect(event: CustomEvent<{item: SlMenuItem}>) {
    switch (event.detail.item.value) {
      case 'rename':
        return this._onMenuSelectRename();
      case 'delete':
        return this._onMenuSelectDelete();
    }
  }

  private _onMenuSelectRename() {
    this.state = 'rename';
  }

  private _onMenuSelectDelete() {
    this._surface.close();
    if (this._project && this.filename) {
      this._project.deleteFile(this.filename);
    }
  }

  private _onFilenameInputChange() {
    // Force re-evaluation of the _filenameInputValid getter (instead of managing
    // an internal property).
    this.requestUpdate();
  }

  private get _filenameInputValid(): boolean {
    return !!(
      this._project &&
      this._filenameInput &&
      this._project.isValidNewFilename(this._filenameInput.value)
    );
  }

  private _onFilenameInputKeydown(event: KeyboardEvent) {
    // Slightly hacky... rather than needing to know which action to perform in
    // each context, we just click whatever submit button we're rendering.
    if (event.key === 'Enter' && this._submitButton?.disabled === false) {
      event.preventDefault();
      this._submitButton.click();
    }
  }

  private _onSubmitRename() {
    this._surface.close();
    const oldFilename = this.filename;
    const newFilename = this._filenameInput?.value;
    if (this._project && oldFilename && newFilename) {
      this._project.renameFile(oldFilename, newFilename);
    }
  }

  private _onSubmitNewFile() {
    this._surface.close();
    const filename = this._filenameInput?.value;
    if (this._project && filename) {
      this._project.addFile(filename);
      this.dispatchEvent(
        new CustomEvent<{filename: string}>('newFile', {
          detail: {filename},
        })
      );
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'playground-file-system-controls': PlaygroundFileSystemControls;
  }
}
