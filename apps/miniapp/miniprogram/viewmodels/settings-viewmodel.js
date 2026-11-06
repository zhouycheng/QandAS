const repository = require('../repositories/practice-repository.js');
const { buildPreferenceView, FONT_SIZE_OPTIONS } = require('../utils/preferences.js');
const { defaultPreset, describePreset } = require('../utils/practice-presets.js');
const FONT_PREVIEW_TEXT = '下列哪项属于可再生能源？';
class SettingsViewModel {
    constructor(options) { this.repository = options.repository || repository; this.storage = options.storage; }
    static getInitialData() { return { switches: [], choices: [], fontSize: 'normal', fontIndex: 1, fontLabel: '标准', fontOptions: FONT_SIZE_OPTIONS, fontPreviewText: FONT_PREVIEW_TEXT }; }
    load() {
        const preferences = this.repository.getPreferences(this.storage);
        return { data: Object.assign(SettingsViewModel.getInitialData(), buildPreferenceView(preferences), this.previewFont(FONT_SIZE_OPTIONS.findIndex(option => option.value === preferences.fontSize)).data, { presetSummary: defaultPreset(preferences).name + ' · ' + describePreset(defaultPreset(preferences)) }) };
    }
    save(action) {
        try {
            action();
            return this.load();
        }
        catch (error) {
            return { data: this.load().data, command: { type: 'toast', title: '设置保存失败，请释放本机空间后重试' } };
        }
    }
    toggleSwitch(key, value) { return key ? this.save(() => this.repository.updatePreferenceSwitch(this.storage, key, !!value)) : null; }
    selectChoice(key, value) { return this.save(() => this.repository.updatePreferenceChoice(this.storage, key, value)); }
    previewFont(index) {
        const option = Number.isInteger(index) && FONT_SIZE_OPTIONS[index];
        return option ? { data: { fontSize: option.value, fontIndex: index, fontLabel: option.label } } : null;
    }
    saveFont(index) {
        const preview = this.previewFont(index);
        return preview ? this.selectChoice('fontSize', preview.data.fontSize) : null;
    }
    resetPreferences() {
        const result = this.save(() => this.repository.resetPreferences(this.storage));
        if (!result.command)
            result.command = { type: 'toast', title: '已恢复默认答题偏好' };
        return result;
    }
}
module.exports = { FONT_PREVIEW_TEXT, SettingsViewModel };
