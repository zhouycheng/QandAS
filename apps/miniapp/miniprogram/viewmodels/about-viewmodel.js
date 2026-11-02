const practiceRepository = require('../repositories/practice-repository.js');
const content = require('../data/about.js');
class AboutViewModel {
    constructor(options) {
        const input = options || {};
        this.repository = input.repository || practiceRepository;
        this.storage = input.storage;
        this.version = input.version || '';
    }
    static getInitialData() {
        return { version: '', developers: content.developers, donationCodes: content.donationCodes, paragraphs: content.paragraphs };
    }
    load() {
        return { data: Object.assign(AboutViewModel.getInitialData(), {
                version: this.version
            }) };
    }
    copyDeveloper(username) {
        const member = content.developers.find(item => item.username === username);
        return member ? { command: { type: 'copy', text: member.url } } : null;
    }
}
module.exports = { AboutViewModel };
