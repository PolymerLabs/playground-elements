/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {html, css, LitElement, customElement} from 'lit-element';

import type {PlaygroundInternalTab} from './tab.js';

/**
 * A horizontal bar of tabs.
 *
 * Slots:
 * - default: The <playground-internal-tab> tabs.
 */
@customElement('playground-internal-tab-bar')
export class PlaygroundInternalTabBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      overflow-x: auto;
    }

    :host::-webkit-scrollbar {
      display: none;
    }

    div {
      display: flex;
    }
  `;

  /**
   * Get or set the active tab.
   */
  get active(): PlaygroundInternalTab | undefined {
    return this._active;
  }

  set active(tab: PlaygroundInternalTab | undefined) {
    /**
     * Note the active tab can be set either by setting the bar's `active`
     * property to the tab, or by setting the tab's `active` property to
     * true. The two become synchronized according to the following flow:
     *
     *   bar click/keydown
     *           |
     *           v
     *   bar.active = tab ---> changed? ---> tab.active = true
     *           ^                                 |
     *           |                                 v
     *   bar tabchange listener        changed from false to true?
     *           ^                                 |
     *           |                                 |
     *           +--- tab dispatches tabchange <---+
     */
    const oldActive = this._active;
    if (tab === oldActive) {
      return;
    }
    this._active = tab;
    if (oldActive !== undefined) {
      oldActive.active = false;
    }
    if (tab !== undefined) {
      tab.active = true;
    } else {
      // Usually the tab itself emits the tabchange event, but we need to handle
      // the "no active tab" case here.
      this.dispatchEvent(
        new CustomEvent<{tab?: PlaygroundInternalTab}>('tabchange', {
          detail: {tab: undefined},
          bubbles: true,
        })
      );
    }
  }

  private _tabs: PlaygroundInternalTab[] = [];
  private _active: PlaygroundInternalTab | undefined = undefined;

  render() {
    return html`
      <div role="tablist">
        <slot
          @slotchange=${this._onSlotchange}
          @click=${this._activateTab}
          @keydown=${this._onKeydown}
          @tabchange=${this._activateTab}
        ></slot>
      </div>
    `;
  }

  private _onSlotchange(event: Event) {
    this._tabs = (
      event.target as HTMLSlotElement
    ).assignedElements() as PlaygroundInternalTab[];
    let newActive;
    // Manage the idx and active properties on all tabs. The first tab that
    // asserts it is active wins.
    for (let i = 0; i < this._tabs.length; i++) {
      const tab = this._tabs[i];
      tab.index = i;
      if (newActive !== undefined) {
        tab.active = false;
      } else if (tab.active || tab.hasAttribute('active')) {
        // Check both the active property and the active attribute, because the
        // user could have set the initial active state either way, and it might
        // not have reflected to the other yet.
        newActive = tab;
      }
    }
    this.active = newActive;
  }

  private _activateTab(event: Event) {
    const tab = this._findEventTab(event);
    if (tab === undefined || tab === this.active) {
      return;
    }
    this.active = tab;
    tab?.scrollIntoView({behavior: 'smooth'});
  }

  private async _onKeydown(event: KeyboardEvent) {
    const oldIdx = this.active?.index ?? 0;
    let newIdx = oldIdx;
    if (event.key === 'ArrowLeft') {
      if (oldIdx > 0) {
        newIdx--;
      }
    } else if (event.key === 'ArrowRight') {
      if (oldIdx < this._tabs.length - 1) {
        newIdx++;
      }
    }
    if (newIdx !== oldIdx) {
      const tab = this._tabs[newIdx];
      this.active = tab;
      // Wait for tabindex to update so we can call focus.
      await tab.updateComplete;
      tab.focus();
    }
  }

  private _findEventTab(event: Event): PlaygroundInternalTab | undefined {
    const target = event.target as HTMLElement | undefined;
    if (target?.localName === 'playground-internal-tab') {
      return event.target as PlaygroundInternalTab;
    }
    for (const el of event.composedPath()) {
      if (
        (el as HTMLElement | undefined)?.localName === 'playground-internal-tab'
      ) {
        return el as PlaygroundInternalTab;
      }
    }
    return undefined;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'playground-internal-tab-bar': PlaygroundInternalTabBar;
  }
}