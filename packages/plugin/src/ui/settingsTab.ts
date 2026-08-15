/**
 * The settings tab (§3.8).
 */

import { PluginSettingTab, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type NotePublisherPlugin from '../main.js';

export class PublisherSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: NotePublisherPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('Your worker origin, e.g. https://notes.<subdomain>.workers.dev')
      .addText((text) =>
        text
          .setPlaceholder('https://notes.example.workers.dev')
          .setValue(settings.baseUrl)
          .onChange((value) => {
            settings.baseUrl = value.trim().replace(/\/+$/, '');
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Manifest token')
      .setDesc(
        'Optional. Without it the plugin issues one HEAD per known note instead, which covers ' +
          'every status except a share_id live in KV that nothing local references. Note this ' +
          'token returns every published share_id at once — it is the index of your unlisted ' +
          'URLs, and it is stored in plain text in this plugin’s data.json.',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setValue(settings.manifestToken)
          .onChange((value) => {
            settings.manifestToken = value.trim();
            save();
          });
      });

    new Setting(containerEl).setName('Staging').setHeading();

    new Setting(containerEl)
      .setName('Staging folder')
      .setDesc(
        'The tracked directory CI reads. Files enter it only when the review modal opens; ' +
          'work in progress lives in the gitignored .publish-pending/.',
      )
      .addText((text) =>
        text.setValue(settings.stagingFolder).onChange((value) => {
          settings.stagingFolder = value.trim().replace(/^\/+|\/+$/g, '') || 'published';
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Materialize Dataview queries')
      .setDesc('Replace each query with its markdown output at stage time. A published table is a snapshot.')
      .addToggle((toggle) =>
        toggle.setValue(settings.dataview).onChange((value) => {
          settings.dataview = value;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Auto-restage on save')
      .setDesc(
        'Off by default, deliberately. Restaging on every save means publishing half-finished ' +
          'edits; surfacing them as Stale and requiring one deliberate action is safer.',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.autoRestageOnSave).onChange((value) => {
          settings.autoRestageOnSave = value;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Transclusion depth cap')
      .addSlider((slider) =>
        slider
          .setLimits(1, 8, 1)
          .setDynamicTooltip()
          .setValue(settings.transclusionDepth)
          .onChange((value) => {
            settings.transclusionDepth = value;
            save();
          }),
      );

    new Setting(containerEl).setName('Attachments').setHeading();

    new Setting(containerEl)
      .setName('Warn above (MB)')
      .addText((text) =>
        text.setValue(String(settings.attachmentWarnBytes / 1024 / 1024)).onChange((value) => {
          const mb = Number(value);
          if (Number.isFinite(mb) && mb > 0) {
            settings.attachmentWarnBytes = Math.round(mb * 1024 * 1024);
            save();
          }
        }),
      );

    new Setting(containerEl)
      .setName('Fail above (MB)')
      .addText((text) =>
        text.setValue(String(settings.attachmentFailBytes / 1024 / 1024)).onChange((value) => {
          const mb = Number(value);
          if (Number.isFinite(mb) && mb > 0) {
            settings.attachmentFailBytes = Math.round(mb * 1024 * 1024);
            save();
          }
        }),
      );

    new Setting(containerEl).setName('Git').setHeading();

    new Setting(containerEl)
      .setName('Git mode')
      .setDesc(
        'The plugin never stores a git credential. Obsidian Git reuses its own configuration; ' +
          'system git uses your SSH agent or credential helper.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            auto: 'Auto-detect',
            'obsidian-git': 'Obsidian Git',
            system: 'System git',
            disabled: 'Disabled',
          })
          .setValue(settings.gitMode)
          .onChange((value) => {
            settings.gitMode = value as typeof settings.gitMode;
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Commit message template')
      .setDesc('{summary} is replaced with a count of what changed.')
      .addText((text) =>
        text.setValue(settings.commitMessageTemplate).onChange((value) => {
          settings.commitMessageTemplate = value || 'publish: {summary}';
          save();
        }),
      );

    new Setting(containerEl).setName('Entry points').setHeading();

    new Setting(containerEl)
      .setName('File context menu')
      .setDesc('Add publish actions to the file explorer right-click menu.')
      .addToggle((toggle) =>
        toggle.setValue(settings.fileContextMenu).onChange((value) => {
          settings.fileContextMenu = value;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Editor context menu')
      .addToggle((toggle) =>
        toggle.setValue(settings.editorContextMenu).onChange((value) => {
          settings.editorContextMenu = value;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Open review after staging from the context menu')
      .setDesc('Right-click, then confirm. Two clicks, with the review gate intact.')
      .addToggle((toggle) =>
        toggle.setValue(settings.openReviewAfterContextStage).onChange((value) => {
          settings.openReviewAfterContextStage = value;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Default panel placement')
      .setDesc('The workspace can always override this by dragging the tab.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ tab: 'Main tab', right: 'Right sidebar', left: 'Left sidebar' })
          .setValue(settings.defaultPanelPlacement)
          .onChange((value) => {
            settings.defaultPanelPlacement = value as typeof settings.defaultPanelPlacement;
            save();
          }),
      );

    new Setting(containerEl)
      .setName('Refresh interval (minutes)')
      .setDesc('0 disables background refresh. The panel always refreshes when opened.')
      .addText((text) =>
        text.setValue(String(settings.refreshIntervalMinutes)).onChange((value) => {
          const minutes = Number(value);
          if (Number.isFinite(minutes) && minutes >= 0) {
            settings.refreshIntervalMinutes = Math.round(minutes);
            save();
          }
        }),
      );

    new Setting(containerEl).setName('Property names').setHeading();
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Rename the frontmatter keys the plugin manages, to avoid collisions with your own.',
    });

    const properties: [keyof typeof settings.properties, string][] = [
      ['publish', 'Publish flag'],
      ['shareId', 'Share id'],
      ['title', 'Title override'],
      ['index', 'Allow indexing'],
      ['download', 'Offer download'],
      ['ack', 'Empty-query acknowledgement'],
    ];

    for (const [key, label] of properties) {
      new Setting(containerEl).setName(label).addText((text) =>
        text.setValue(settings.properties[key]).onChange((value) => {
          settings.properties[key] = value.trim() || settings.properties[key];
          save();
        }),
      );
    }
  }
}
