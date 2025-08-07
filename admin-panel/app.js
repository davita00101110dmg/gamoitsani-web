// Configuration and Constants
const firebaseConfig = {
    apiKey: window.config.FIREBASE_API_KEY,
    authDomain: window.config.FIREBASE_AUTH_DOMAIN,
    databaseURL: window.config.FIREBASE_DATABASE_URL,
    projectId: window.config.FIREBASE_PROJECT_ID,
    storageBucket: window.config.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: window.config.FIREBASE_MESSAGING_SENDER_ID,
    appId: window.config.FIREBASE_APP_ID,
    measurementId: window.config.FIREBASE_MEASUREMENT_ID
};

// Constant Enums and Configurations
const COLLECTION_NAMES = {
    production: {
        suggested: "new_suggested_words",
        words: "new_words"
    },
    testing: {
        suggested: "test_new_suggested_words",
        words: "test_new_words"
    }
};

const WordStatus = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    TRANSLATED: 'translated',
    FAILED: 'failed',
    ACCEPTED: 'accepted'
};

const ValidationResult = {
    PASSED: 'passed',
    FAILED_TRANSLATION: 'failed_translation',
    FAILED_OTHER: 'failed_other'
};

const ProcessingConfig = {
    batchSize: 5,
    retryDelay: 2000,
    maxRetries: 3
};

const AutoProcessingConfig = {
    isEnabled: false,
    mode: 'testing',
    minWordLength: 2,
    maxWordLength: 20,
    requiredTranslationSuccess: 0.7,
    
    get collections() {
        return this.mode === 'testing' ? 
            COLLECTION_NAMES.testing : 
            COLLECTION_NAMES.production;
    }
};

// Firebase Initialization
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Translation Validator
const TranslationValidator = {
    excludedWords: new Set(['the', 'a', 'and', 'in', 'to', 'is', 'it', 'for', 'on', 'with', 'at']),
    wordPattern: /^[a-zA-Z]{2,20}$/,

    async validateWord(word) {
        if (!word) return false;

        const cleanWord = word.trim().toLowerCase();

        if (!this.wordPattern.test(cleanWord)) {
            console.log(`Invalid word composition: ${word}`);
            return false;
        }

        if (this.excludedWords.has(cleanWord)) {
            console.log(`Word is too common: ${word}`);
            return false;
        }

        try {
            const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${cleanWord}`);
            
            if (response.status === 200) {
                return true;
            } else if (response.status === 404) {
                console.log(`Word not found in dictionary: ${word}`);
                return false;
            } else {
                console.error(`Dictionary API error for word: ${word}`);
                return false;
            }
        } catch (error) {
            console.error(`Error validating word ${word}:`, error);
            return false;
        }
    },

    async validateEnglishTranslation(translation) {
        if (!translation) {
            return { 
                isValid: false, 
                reason: 'No translation provided' 
            };
        }

        const isValid = await this.validateWord(translation);

        return {
            isValid,
            reason: isValid ? null : 'Word not found in dictionary'
        };
    },

    async validateAllTranslations(translations) {
        const englishTranslation = translations['en']?.word;
        const englishValidation = await this.validateEnglishTranslation(englishTranslation);

        if (!englishValidation.isValid) {
            return {
                isValid: false,
                successRate: 0,
                reason: `Invalid English translation: ${englishValidation.reason}`
            };
        }

        const successCount = Object.entries(translations)
            .filter(([lang, trans]) => {
                if (lang === 'en') return true;
                return trans && trans.word && !trans.word.includes(' ');
            }).length;

        const successRate = successCount / Object.keys(translations).length;
        
        return {
            isValid: successRate >= AutoProcessingConfig.requiredTranslationSuccess,
            successRate,
            reason: successRate < AutoProcessingConfig.requiredTranslationSuccess ? 
                    'Insufficient valid translations' : null
        };
    }
};

// Utility Functions
function slugify(text) {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-');
}

function getCollectionNames() {
    return AutoProcessingConfig.mode === 'testing' 
        ? COLLECTION_NAMES.testing 
        : COLLECTION_NAMES.production;
}

function getCollectionReferences() {
    const names = getCollectionNames();
    return {
        suggested: db.collection(names.suggested),
        words: db.collection(names.words)
    };
}

// API and Translation Functions
async function fetchSupportedLanguages() {
    const languagesSnapshot = await db.collection('supported_languages').get();
    return languagesSnapshot.docs.map(doc => doc.data().code);
}

async function fetchCategories() {
    const categoriesSnapshot = await db.collection('categories').get();
    return categoriesSnapshot.docs.map(doc => doc.data().name);
}

async function translateWord(word, sourceLang, targetLang) {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${window.config.GOOGLE_API_KEY}`;
    try {
        console.log(`Attempting to translate "${word}" from ${sourceLang} to ${targetLang}`);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                q: word, 
                target: targetLang,
                source: sourceLang,
                format: 'text'
            })
        });
        const data = await response.json();
        if (data.error) {
            throw new Error(data.error.message);
        }
        let translatedText = data.data.translations[0].translatedText;
        translatedText = translatedText.charAt(0).toUpperCase() + translatedText.slice(1);
        console.log(`API returned translation for "${word}" to ${targetLang}: "${translatedText}"`);
        return translatedText !== word ? translatedText : null;
    } catch (error) {
        console.error(`Translation error for "${word}" to ${targetLang}:`, error);
        return null;
    }
}

// Auto Processor
const AutoProcessor = {
    async processWord(wordData, updateUI = true) {
        console.log(`Auto-processing word: ${wordData.base_word}`);
        
        await this.updateWordStatus(wordData.id, WordStatus.PROCESSING);
        
        try {
            const processedData = await this.processTranslations(wordData.base_word, wordData.language);
            if (!processedData) {
                await this.handleFailedValidation(wordData.id, {
                    status: WordStatus.FAILED,
                    validationResult: 'failed_translation',
                    failureReason: 'Failed to process translations'
                });
                return false;
            }

            const translationValidation = await TranslationValidator.validateAllTranslations(processedData.translations);
            
            if (!translationValidation.isValid) {
                await this.handleFailedValidation(wordData.id, {
                    status: WordStatus.FAILED,
                    validationResult: 'failed_validation',
                    failureReason: translationValidation.reason || 'Translation validation failed'
                });
                return false;
            }

            await this.moveToMainCollection(wordData, processedData);
            return true;

        } catch (error) {
            console.error(`Error processing word ${wordData.base_word}:`, error);
            await this.handleFailedValidation(wordData.id, {
                status: WordStatus.FAILED,
                validationResult: 'failed_other',
                failureReason: error.message || 'Unexpected error during processing'
            });
            return false;
        }
    },

    async processTranslations(baseWord, baseLanguage) {
        const supportedLanguages = await fetchSupportedLanguages();
        const translations = {
            [baseLanguage]: { word: baseWord, difficulty: 1 }
        };

        for (const lang of supportedLanguages) {
            if (lang !== baseLanguage) {
                const translatedWord = await translateWord(baseWord, baseLanguage, lang);
                translations[lang] = {
                    word: translatedWord || baseWord,
                    difficulty: 1
                };
            }
        }

        return {
            translations
        };
    },

    async moveToMainCollection(wordData, processedData) {
        const collections = getCollectionReferences();
        
        try {
            const englishTranslation = processedData.translations?.['en']?.word || 
                                     wordData.base_word;
            
            if (!englishTranslation) {
                throw new Error('No valid word found for document ID');
            }
        
            const wordId = slugify(englishTranslation);
            
            await collections.words.doc(wordId).set({
                base_word: wordData.base_word,
                categories: [],
                translations: processedData.translations,
                last_updated: firebase.firestore.FieldValue.serverTimestamp()
            });
    
            await collections.suggested.doc(wordData.id).delete();
            console.log(`Word successfully moved to ${collections.words.path}`);
            await this.updateStatistics();
            return true;
    
        } catch (error) {
            console.error('Error moving word to main collection:', error);
            await this.handleFailedValidation(wordData.id, {
                status: WordStatus.FAILED,
                validationResult: ValidationResult.FAILED_OTHER,
                failureReason: 'Error moving to main collection: ' + error.message
            });
            return false;
        }
    },

    async updateWordStatus(wordId, status, additionalData = {}) {
        const collections = getCollectionReferences();
        await collections.suggested.doc(wordId).update({
            status,
            ...additionalData,
            lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    async handleFailedValidation(wordId, failureData) {
        await this.updateWordStatus(wordId, WordStatus.FAILED, failureData);
        await this.updateStatistics();
        return false;
    },

    async updateStatistics() {
        const collections = getCollectionReferences();
        const stats = {
            pending: 0,
            translated: 0,
            failed: 0,
            accepted: 0
        };

        const snapshot = await collections.suggested.get();
        snapshot.docs.forEach(doc => {
            const status = doc.data().status || WordStatus.PENDING;
            if (stats.hasOwnProperty(status)) {
                stats[status]++;
            }
        });

        // Update UI counters
        Object.entries(stats).forEach(([status, count]) => {
            const element = document.getElementById(`${status}Count`);
            if (element) element.textContent = count;
            
            // Update tab counts
            const tabElement = document.getElementById(`${status}TabCount`);
            if (tabElement) tabElement.textContent = count;
        });
    },

    async processAllPending() {
        console.log('Starting to process all pending words...');
        
        const collections = getCollectionReferences();
        const progressContainer = document.getElementById('progressBarContainer');
        const progressBar = document.getElementById('progressBar');
        const progressText = document.getElementById('progressText');

        try {
            const snapshot = await collections.suggested
                .where('status', '==', WordStatus.PENDING)
                .get();

            const pendingWords = snapshot.docs;
            const total = pendingWords.length;

            if (total === 0) {
                alert('No pending words to process.');
                return;
            }

            progressContainer.style.display = 'block';
            progressBar.style.width = '0%';

            let processed = 0;
            let successCount = 0;
            let failureCount = 0;

            for (const doc of pendingWords) {
                const wordData = doc.data();
                
                try {
                    const processingResult = await this.processWord(
                        { 
                            id: doc.id, 
                            base_word: wordData.base_word, 
                            language: wordData.language 
                        }
                    );

                    if (processingResult) {
                        successCount++;
                    } else {
                        failureCount++;
                    }
                } catch (wordProcessingError) {
                    console.error(`Error processing word ${wordData.base_word}:`, wordProcessingError);
                    failureCount++;
                }

                processed++;
                const percentage = Math.round((processed / total) * 100);
                progressBar.style.width = `${percentage}%`;
                progressText.textContent = `${percentage}% (${processed}/${total}) - Success: ${successCount}, Failures: ${failureCount}`;
            }

            progressContainer.style.display = 'none';
            await this.updateStatistics();
            
            alert(`Processing complete.\nTotal words: ${total}\nSuccessful: ${successCount}\nFailed: ${failureCount}`);

        } catch (error) {
            console.error('Error processing pending words:', error);
            alert('An error occurred while processing words. Please try again.');
            progressContainer.style.display = 'none';
        }
    }
};

// Word Management Functions
async function handleTranslation(suggestionKey, wordData) {
    const collections = getCollectionReferences();
    
    if (wordData.translations && Object.keys(wordData.translations).length > 0) {
        console.log("Word already translated. Skipping re-translation.");
        return;
    }

    const processedData = await AutoProcessor.processTranslations(wordData.base_word, wordData.language);
    if (!processedData) {
        console.error(`Failed to process word "${wordData.base_word}"`);
        await collections.suggested.doc(suggestionKey).update({
            status: WordStatus.FAILED,
            failureReason: 'Failed to translate word'
        });
        alert(`Failed to translate "${wordData.base_word}". Please try again.`);
        return;
    }

    try {
        await collections.suggested.doc(suggestionKey).update({
            ...wordData,
            ...processedData,
            status: WordStatus.TRANSLATED
        });
        console.log(`Successfully translated "${wordData.base_word}"`);
        await AutoProcessor.updateStatistics();
        
        // Show success feedback
        const wordElement = document.querySelector(`[data-key="${suggestionKey}"]`);
        if (wordElement) {
            wordElement.style.animation = 'fadeIn 0.5s ease-out';
        }
    } catch (error) {
        console.error(`Error updating word data for "${wordData.base_word}":`, error);
        alert(`Error updating word: ${error.message}`);
    }
}

async function addSuggestionToWords(suggestionKey, wordData) {
    const collections = getCollectionReferences();
    try {
        const englishTranslation = wordData.translations?.['en']?.word || wordData.base_word;
        const wordId = slugify(englishTranslation);

        const existingWord = await collections.words.doc(wordId).get();
        if (existingWord.exists) {
            console.log(`Word "${englishTranslation}" already exists in ${collections.words.path}`);
            await collections.suggested.doc(suggestionKey).delete();
            return;
        }

        let processedWordData = wordData;
        if (!wordData.translations || Object.keys(wordData.translations).length === 0) {
            const processedData = await AutoProcessor.processTranslations(wordData.base_word, wordData.language || 'en');
            if (!processedData) {
                console.error(`Failed to process word "${wordData.base_word}"`);
                return;
            }
            processedWordData = { ...wordData, ...processedData };
        }

        await collections.words.doc(wordId).set({
            base_word: processedWordData.base_word,
            language: processedWordData.language,
            translations: processedWordData.translations,
            categories: [],
            status: WordStatus.ACCEPTED,
            autoProcessed: AutoProcessingConfig.isEnabled,
            processedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        await collections.suggested.doc(suggestionKey).delete();
        console.log(`Word "${processedWordData.base_word}" added to ${collections.words.path}`);
        await AutoProcessor.updateStatistics();

    } catch (error) {
        console.error('Error adding word:', error);
    }
}

async function removeSuggestion(suggestionKey) {
    const collections = getCollectionReferences();
    try {
        await collections.suggested.doc(suggestionKey).delete();
        console.log(`Suggestion with key "${suggestionKey}" removed from ${collections.suggested.path}`);
        await AutoProcessor.updateStatistics();
    } catch (error) {
        console.error('Error removing suggestion:', error);
    }
}

// Import Functions
async function importWordsFromTxt(file) {
    try {
        console.log(`Starting import process in ${AutoProcessingConfig.mode} mode...`);

        const language = await askForLanguage();
        if (!language) {
            console.log("Language selection cancelled");
            return;
        }

        const words = await readWordsFromFile(file);
        if (words.length === 0) {
            alert('No words found in the file.');
            return;
        }

        const existingWords = await getExistingWords();
        const newWords = words.filter(word => !existingWords.has(word.toLowerCase()));

        if (newWords.length === 0) {
            alert(`All words already exist in the ${AutoProcessingConfig.mode} collections.`);
            return;
        }

        document.getElementById('progressBarContainer').style.display = 'block';
        await processAndImportWords(newWords, language);
        document.getElementById('progressBarContainer').style.display = 'none';

        alert(`Import complete. ${newWords.length} words added to ${AutoProcessingConfig.mode} collections.`);
        
        await AutoProcessor.updateStatistics();

        if (AutoProcessingConfig.isEnabled) {
            const shouldProcess = confirm('Would you like to auto-process the imported words now?');
            if (shouldProcess) {
                await AutoProcessor.processAllPending();
            }
        }
    } catch (error) {
        console.error('Error importing words:', error);
        alert(`Error during import: ${error.message}`);
        document.getElementById('progressBarContainer').style.display = 'none';
    }
}

async function askForLanguage() {
    const supportedLanguages = await fetchSupportedLanguages();
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 300px;">
                <h3 style="margin-bottom: 1rem;">Select Language</h3>
                <select id="langSelect" class="select-input" style="width: 100%; margin-bottom: 1rem;">
                    ${supportedLanguages.map(lang => `<option value="${lang}">${lang.toUpperCase()}</option>`).join('')}
                </select>
                <div style="display: flex; gap: 0.5rem;">
                    <button id="langCancel" class="btn-action" style="flex: 1;">Cancel</button>
                    <button id="langOK" class="btn-primary" style="flex: 1;">OK</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('langCancel').onclick = () => {
            document.body.removeChild(modal);
            resolve(null);
        };

        document.getElementById('langOK').onclick = () => {
            const selected = document.getElementById('langSelect').value;
            document.body.removeChild(modal);
            resolve(selected);
        };
    });
}

async function readWordsFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const content = event.target.result;
                const words = content.split('\n').map(word => word.trim()).filter(word => word !== '');
                resolve(words);
            } catch (error) {
                reject(error);
            }
        };
        reader.onerror = (error) => reject(error);
        reader.readAsText(file);
    });
}

async function getExistingWords() {
    try {
        const collections = getCollectionReferences();
        const wordsSnapshot = await collections.words.get();
        const suggestionsSnapshot = await collections.suggested.get();
        
        const existingWords = new Set();
        
        for (const doc of wordsSnapshot.docs) {
            const data = doc.data();
            if (data?.base_word) {
                existingWords.add(data.base_word.toLowerCase());
            }
        }
        
        for (const doc of suggestionsSnapshot.docs) {
            const data = doc.data();
            if (data?.base_word) {
                existingWords.add(data.base_word.toLowerCase());
            }
        }

        console.log(`Found ${existingWords.size} existing words in ${AutoProcessingConfig.mode} collections`);
        return existingWords;
    } catch (error) {
        console.error('Error fetching existing words:', error);
        throw error;
    }
}

async function processAndImportWords(words, language) {
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const collections = getCollectionReferences();
    
    progressBar.style.width = '0%';

    for (let i = 0; i < words.length; i++) {
        try {
            const word = words[i];
            console.log(`Importing word: ${word}`);

            const wordData = {
                base_word: word,
                base_word_lower: word.toLowerCase(),
                language: language,
                status: WordStatus.PENDING,
                addedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            const docRef = await collections.suggested.add(wordData);
            console.log(`Added word "${word}" with ID: ${docRef.id}`);

            const progressPercentage = Math.round(((i + 1) / words.length) * 100);
            progressBar.style.width = `${progressPercentage}%`;
            progressText.textContent = `${progressPercentage}% (${i + 1}/${words.length})`;
        } catch (error) {
            console.error(`Error importing word "${words[i]}":`, error);
        }
    }
}

// Translation of all words
async function translateAllWords() {
    const translateAllButton = document.getElementById('translateAllButton');
    translateAllButton.disabled = true;
    translateAllButton.innerHTML = '<span class="loading"></span> Translating...';

    try {
        const collections = getCollectionReferences();
        const snapshot = await collections.suggested
            .where('status', 'in', [WordStatus.PENDING, WordStatus.FAILED])
            .get();
        
        let total = snapshot.docs.length;
        
        if (total === 0) {
            alert('No words to translate.');
            return;
        }
        
        let processed = 0;

        const progressContainer = document.getElementById('progressBarContainer');
        const progressBar = document.getElementById('progressBar');
        const progressText = document.getElementById('progressText');
        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';

        for (const doc of snapshot.docs) {
            const wordData = doc.data();
            
            if (!wordData.translations || Object.keys(wordData.translations).length === 0) {
                await handleTranslation(doc.id, wordData);
            }
            
            processed++;
            const percentage = Math.round((processed / total) * 100);
            progressBar.style.width = `${percentage}%`;
            progressText.textContent = `${percentage}% (${processed}/${total})`;
        }

        progressContainer.style.display = 'none';
        await AutoProcessor.updateStatistics();
        alert(`Translation complete. ${processed} words processed.`);
        
    } catch (error) {
        console.error('Error translating all words:', error);
        alert('An error occurred while translating words. Please try again.');
    } finally {
        translateAllButton.disabled = false;
        translateAllButton.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 5h12M9 3v2M10.048 14.5c.238-1.5 1.238-2.5 2.452-2.5s2.214 1 2.452 2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Translate All</span>';
        document.getElementById('progressBarContainer').style.display = 'none';
    }
}

// UI Functions
function createWordElement(suggestionKey, wordData) {
    const wordItem = document.createElement('div');
    wordItem.className = 'word-item';
    wordItem.dataset.key = suggestionKey;

    const hasTranslations = wordData.translations && Object.keys(wordData.translations).length > 0;
    const isFailed = wordData.status === WordStatus.FAILED;
    
    // Default to PENDING if no status is set
    const currentStatus = wordData.status || WordStatus.PENDING;

    let translationsHTML = '';
    if (hasTranslations) {
        translationsHTML = `
            <div class="word-translations">
                <div class="translations-title">Translations</div>
                <div class="translations-grid">
                    ${Object.entries(wordData.translations).map(([lang, trans]) => `
                        <div class="translation-item">
                            <div class="translation-lang">${lang}</div>
                            <div class="translation-word">${trans.word}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    let actionsHTML = '';
    // Show action buttons for PENDING status or if no status is set
    if (currentStatus === WordStatus.PENDING || !wordData.status) {
        actionsHTML = `
            <div class="word-actions">
                <button class="btn-word-action btn-translate" onclick="handleWordAction('${suggestionKey}', 'translate')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M3 5h12M9 3v2M10.048 14.5c.238-1.5 1.238-2.5 2.452-2.5s2.214 1 2.452 2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Translate
                </button>
                <button class="btn-word-action btn-decline" onclick="handleWordAction('${suggestionKey}', 'remove')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Delete
                </button>
            </div>
        `;
    } else if (currentStatus === WordStatus.TRANSLATED) {
        actionsHTML = `
            <div class="word-actions">
                <button class="btn-word-action btn-accept" onclick="handleWordAction('${suggestionKey}', 'add')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M5 12l5 5L20 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Accept
                </button>
                <button class="btn-word-action btn-decline" onclick="handleWordAction('${suggestionKey}', 'remove')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Decline
                </button>
            </div>
        `;
    } else if (currentStatus === WordStatus.FAILED) {
        actionsHTML = `
            <div class="word-actions">
                <button class="btn-word-action btn-retry" onclick="handleWordAction('${suggestionKey}', 'translate')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 105.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Retry
                </button>
                <button class="btn-word-action btn-decline" onclick="handleWordAction('${suggestionKey}', 'remove')">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    Remove
                </button>
            </div>
        `;
    }

    const timestamp = wordData.addedAt ? new Date(wordData.addedAt.toDate()).toLocaleString() : 'N/A';
    
    wordItem.innerHTML = `
        <div class="word-header">
            <div class="word-info">
                <div class="word-base">${wordData.base_word}</div>
                <div class="word-meta">
                    <span class="word-language">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                            <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        ${wordData.language || 'Unknown'}
                    </span>
                    <span class="word-timestamp">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                            <path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                        ${timestamp}
                    </span>
                </div>
            </div>
            <div class="word-status status-${currentStatus}">
                ${currentStatus.toUpperCase()}
                ${isFailed && wordData.failureReason ? `<span class="failure-reason">${wordData.failureReason}</span>` : ''}
            </div>
        </div>
        ${translationsHTML}
        ${actionsHTML}
    `;

    return wordItem;
}

function updateWordInUI(suggestionKey, wordData) {
    const existingItem = document.querySelector(`[data-key="${suggestionKey}"]`);
    if (existingItem) {
        existingItem.remove();
    }

    const targetList = getListForStatus(wordData.status);
    if (targetList) {
        const newElement = createWordElement(suggestionKey, wordData);
        targetList.appendChild(newElement);
    }
}

function getListForStatus(status) {
    // Default to PENDING if no status is set
    const actualStatus = status || WordStatus.PENDING;
    
    switch (actualStatus) {
        case WordStatus.PENDING:
            return document.getElementById('pendingList');
        case WordStatus.TRANSLATED:
            return document.getElementById('translatedList');
        case WordStatus.FAILED:
            return document.getElementById('failedList');
        default:
            return document.getElementById('pendingList');
    }
}

// Global function for handling word actions
window.handleWordAction = async function(suggestionKey, action) {
    const collections = getCollectionReferences();
    const doc = await collections.suggested.doc(suggestionKey).get();
    
    if (!doc.exists) {
        console.error(`Document ${suggestionKey} not found`);
        return;
    }
    
    const wordData = doc.data();
    
    // Provide visual feedback
    const wordElement = document.querySelector(`[data-key="${suggestionKey}"]`);
    if (wordElement) {
        const actionButton = wordElement.querySelector(`.btn-${action === 'add' ? 'accept' : action === 'remove' ? 'decline' : 'translate'}`);
        if (actionButton) {
            actionButton.disabled = true;
            actionButton.innerHTML = '<span class="loading"></span> Processing...';
        }
    }

    try {
        if (action === 'add') {
            await addSuggestionToWords(suggestionKey, wordData);
        } else if (action === 'remove') {
            if (confirm(`Are you sure you want to delete "${wordData.base_word}"?`)) {
                await removeSuggestion(suggestionKey);
            }
        } else if (action === 'translate') {
            await handleTranslation(suggestionKey, wordData);
        }
    } catch (error) {
        console.error(`Error performing action ${action}:`, error);
        alert(`Error: ${error.message}`);
        
        // Restore button state on error
        if (wordElement) {
            const actionButton = wordElement.querySelector(`.btn-${action === 'add' ? 'accept' : action === 'remove' ? 'decline' : 'translate'}`);
            if (actionButton) {
                actionButton.disabled = false;
                actionButton.innerHTML = action === 'translate' ? 
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 5h12M9 3v2M10.048 14.5c.238-1.5 1.238-2.5 2.452-2.5s2.214 1 2.452 2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Translate' :
                    action === 'remove' ? 
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Delete' :
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Accept';
            }
        }
    }
};

// Tab Management
function initializeTabs() {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const targetTab = button.dataset.tab;

            // Update active states
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabPanes.forEach(pane => pane.classList.remove('active'));

            button.classList.add('active');
            document.getElementById(`${targetTab}Tab`).classList.add('active');
        });
    });
}

// Authentication Functions
async function login() {
    const emailInput = document.getElementById('emailInput');
    const passwordInput = document.getElementById('passwordInput');
    const loginError = document.getElementById('loginError');
    
    try {
        await firebase.auth().signInWithEmailAndPassword(emailInput.value, passwordInput.value);
        console.log('User logged in successfully.');
        updateUIForLoggedInUser();
    } catch (error) {
        console.error('Error logging in:', error);
        loginError.textContent = error.message;
    }
}

function logout() {
    firebase.auth().signOut()
        .then(() => {
            console.log('User logged out.');
            updateUIForLoggedOutUser();
        })
        .catch(error => {
            console.error('Error logging out:', error);
        });
}

function updateUIForLoggedInUser() {
    document.getElementById('authModal').style.display = 'none';
    document.getElementById('appContent').style.display = 'block';
    document.getElementById('loginError').textContent = '';
    setupListeners();
    AutoProcessor.updateStatistics();
}

function updateUIForLoggedOutUser() {
    document.getElementById('authModal').style.display = 'flex';
    document.getElementById('appContent').style.display = 'none';
    
    // Clear lists
    document.getElementById('pendingList').innerHTML = '';
    document.getElementById('translatedList').innerHTML = '';
    document.getElementById('failedList').innerHTML = '';
    
    // Clear any existing Firebase listeners
    if (window.currentListener) {
        window.currentListener();
        window.currentListener = null;
    }
}

// Setup Firebase Listeners
function setupListeners() {
    if (window.currentListener) {
        window.currentListener();
    }

    const collections = getCollectionReferences();
    
    // Clear lists before populating
    document.getElementById('pendingList').innerHTML = '';
    document.getElementById('translatedList').innerHTML = '';
    document.getElementById('failedList').innerHTML = '';
    
    window.currentListener = collections.suggested.onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            const suggestionKey = change.doc.id;
            const wordData = change.doc.data();
            
            if (change.type === 'added' || change.type === 'modified') {
                updateWordInUI(suggestionKey, wordData);
            } else if (change.type === 'removed') {
                const suggestionItem = document.querySelector(`[data-key="${suggestionKey}"]`);
                if (suggestionItem) {
                    suggestionItem.remove();
                }
            }
        });
        
        AutoProcessor.updateStatistics();
    });
}

function updateModeIndicator() {
    const modeBadge = document.getElementById('modeBadge');
    const modeText = modeBadge.querySelector('.mode-text');
    
    if (AutoProcessingConfig.mode === 'production') {
        modeBadge.classList.remove('testing');
        modeBadge.classList.add('production');
        modeText.textContent = 'Production Mode';
    } else {
        modeBadge.classList.remove('production');
        modeBadge.classList.add('testing');
        modeText.textContent = 'Testing Mode';
    }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    // Initialize tabs
    initializeTabs();
    
    // Authentication
    document.getElementById('loginButton').addEventListener('click', login);
    document.getElementById('logoutButton').addEventListener('click', logout);
    
    // Import/Export
    document.getElementById('importButton').addEventListener('click', () => {
        document.getElementById('importFileInput').click();
    });
    
    document.getElementById('importFileInput').addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            importWordsFromTxt(file);
        }
    });
    
    // Translation and Processing
    document.getElementById('translateAllButton').addEventListener('click', translateAllWords);
    
    document.getElementById('autoProcessAllButton').addEventListener('click', async () => {
        if (confirm('Process all pending words? This will translate and validate all pending words.')) {
            const button = document.getElementById('autoProcessAllButton');
            button.disabled = true;
            button.innerHTML = '<span class="loading"></span> Processing...';
            await AutoProcessor.processAllPending();
            button.disabled = false;
            button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2v6l3-3M12 8l-3-3M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Auto Process All</span>';
        }
    });
    
    // Settings
    document.getElementById('autoProcessingToggle').addEventListener('change', (e) => {
        AutoProcessingConfig.isEnabled = e.target.checked;
        console.log(`Auto-processing ${AutoProcessingConfig.isEnabled ? 'enabled' : 'disabled'}`);
    });
    
    document.getElementById('processingMode').addEventListener('change', (e) => {
        AutoProcessingConfig.mode = e.target.value;
        console.log(`Processing mode changed to: ${AutoProcessingConfig.mode}`);
        updateModeIndicator();
        
        // Clear lists and reinitialize
        document.getElementById('pendingList').innerHTML = '';
        document.getElementById('translatedList').innerHTML = '';
        document.getElementById('failedList').innerHTML = '';
        
        if (firebase.auth().currentUser) {
            setupListeners();
        }
    });
    
    // Initialize app
    updateUIForLoggedOutUser();
    updateModeIndicator();
    
    firebase.auth().onAuthStateChanged(user => {
        if (user) {
            updateUIForLoggedInUser();
        }
    });
});