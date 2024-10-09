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

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const suggestedWordsCollection = db.collection("new_suggested_words");
const wordsCollection = db.collection("new_words"); 

// DOM elements
const suggestionList = document.getElementById('suggestionList');
const authModal = document.getElementById('authModal');
const appContent = document.getElementById('appContent');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginButton = document.getElementById('loginButton');
const loginError = document.getElementById('loginError');
const logoutButton = document.getElementById('logoutButton');
const importButton = document.getElementById('importButton');
const importFileInput = document.getElementById('importFileInput');

// Authentication functions
async function login() {
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

// UI update functions
function updateUIForLoggedInUser() {
    authModal.style.display = 'none';
    appContent.style.display = 'block';
    loginError.textContent = '';
}

function updateUIForLoggedOutUser() {
    authModal.style.display = 'block';
    appContent.style.display = 'none';
    suggestionList.innerHTML = '';
}

// Fetch supported languages
async function fetchSupportedLanguages() {
    const languagesSnapshot = await db.collection('supported_languages').get();
    return languagesSnapshot.docs.map(doc => doc.data().code);
}

async function fetchCategories() {
    const categoriesSnapshot = await db.collection('categories').get();
    return categoriesSnapshot.docs.map(doc => doc.data().name);
}

// Translate word
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
        // Capitalize the first letter of the translated word
        translatedText = translatedText.charAt(0).toUpperCase() + translatedText.slice(1);
        console.log(`API returned translation for "${word}" to ${targetLang}: "${translatedText}"`);
        return translatedText !== word ? translatedText : null;
    } catch (error) {
        console.error(`Translation error for "${word}" to ${targetLang}:`, error);
        return null;
    }
}

// Process word with GPT-3.5
async function processWord(word, sourceLanguage) {
    const categories = await fetchCategories();
    const supportedLanguages = await fetchSupportedLanguages();

    const prompt = `Given the word "${word}" in ${sourceLanguage}, provide:
  1. An array of relevant categories (if there aren't more then 1 or even 1 don't add them) for this word from the following list: ${categories.join(', ')}. Choose only the most appropriate categories that directly relate to the word.
  2. A difficulty score for this word in it's language (keep in mind that some word can be easy in some languages and hard in other languages) on a scale of 1-5 (1 being easiest, 5 being hardest) for each of these languages: ${supportedLanguages.join(', ')}
  
  Consider the following when assigning difficulty scores and again, take this criteriums depending on the language:
- Word length (longer words are generally more difficult)
- Word frequency in everyday language (common words are easier)
- Abstractness (concrete words are easier than abstract concepts)
- Cultural specificity (words specific to certain cultures may be more difficult)
- Complexity of meaning (words with multiple or nuanced meanings are more difficult)

  Respond in the following JSON format:
  {
    "categories": ["category1", "category2", "category3"],
    "difficulty_scores": {
      "lang_code": difficulty_score,
      ...
    }
  }`;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${window.config.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: [{ role: "user", content: prompt }]
            })
        });

        const data = await response.json();
        return JSON.parse(data.choices[0].message.content);
    } catch (error) {
        console.error(`Error processing word '${word}':`, error);
        return null;
    }
}

async function processWordFully(baseWord, baseLanguage) {
    const result = await processWord(baseWord, baseLanguage);
    if (!result) return null;

    const supportedLanguages = await fetchSupportedLanguages();
    const translations = {
        [baseLanguage]: { word: baseWord, difficulty: result.difficulty_scores[baseLanguage] || 3 }
    };

    for (const lang of supportedLanguages) {
        if (lang !== baseLanguage) {
            const translatedWord = await translateWord(baseWord, baseLanguage, lang);
            translations[lang] = {
                word: translatedWord || baseWord,
                difficulty: result.difficulty_scores[lang] || 3
            };
        }
    }

    return {
        categories: result.categories,
        translations: translations
    };
}

// Handle word translation
async function handleTranslation(suggestionKey, wordData) {
    if (wordData.translations && Object.keys(wordData.translations).length > 0) {
        console.log("Word already translated. Skipping re-translation.");
        updateUIWithTranslations(suggestionKey, wordData);
        return;
    }

    const baseWord = wordData.base_word;
    const baseLanguage = wordData.language || 'en';

    const processedData = await processWordFully(baseWord, baseLanguage);
    if (!processedData) {
        console.error(`Failed to process word "${baseWord}"`);
        return;
    }

    const updatedWordData = {
        ...wordData,
        ...processedData
    };

    try {
        await suggestedWordsCollection.doc(suggestionKey).update(updatedWordData);
        console.log(`Updated word data for "${baseWord}" in suggested words collection`);
        updateUIWithTranslations(suggestionKey, updatedWordData);
    } catch (error) {
        console.error(`Error updating word data for "${baseWord}":`, error);
    }
}

async function addSuggestionToWords(suggestionKey, wordData) {
    try {
        // Get the English translation of the word
        const englishTranslation = wordData.translations['en']?.word || wordData.base_word;
        const wordId = slugify(englishTranslation);

        const existingWord = await wordsCollection.doc(wordId).get();
        if (existingWord.exists) {
            console.log(`Word "${englishTranslation}" already exists in the new_words collection.`);
            await suggestedWordsCollection.doc(suggestionKey).delete();
            return;
        }

        let processedWordData = wordData;
        if (!wordData.translations || Object.keys(wordData.translations).length === 0 || !wordData.categories) {
            console.log(`Processing word "${wordData.base_word}" before adding to new_words collection.`);
            const processedData = await processWordFully(wordData.base_word, wordData.language || 'en');
            if (!processedData) {
                console.error(`Failed to process word "${wordData.base_word}"`);
                return;
            }
            processedWordData = { ...wordData, ...processedData };
        } else {
            console.log(`Word "${wordData.base_word}" already processed. Using existing data.`);
        }

        const newWordData = {
            base_word: processedWordData.base_word,
            categories: processedWordData.categories,
            translations: processedWordData.translations,
            last_updated: firebase.firestore.FieldValue.serverTimestamp()
        };

        await wordsCollection.doc(wordId).set(newWordData);
        console.log(`Word "${processedWordData.base_word}" added to the new_words collection with ID: ${wordId}`);

        await suggestedWordsCollection.doc(suggestionKey).delete();

        const suggestionItem = document.querySelector(`li[data-key="${suggestionKey}"]`);
        if (suggestionItem) {
            suggestionItem.remove();
        }
    } catch (error) {
        console.error('Error adding word to new_words collection:', error);
    }
}

// Remove suggestion
async function removeSuggestion(suggestionKey) {
    try {
        await suggestedWordsCollection.doc(suggestionKey).delete();
        console.log(`Suggestion with key "${suggestionKey}" removed.`);
        
        const suggestionItem = document.querySelector(`li[data-key="${suggestionKey}"]`);
        if (suggestionItem) {
            suggestionItem.remove();
        }
    } catch (error) {
        console.error('Error removing suggestion:', error);
    }
}

// Handle word actions (add or remove)
function handleWordAction(suggestionKey, action, wordData) {
    if (action === 'add') {
        addSuggestionToWords(suggestionKey, wordData);
    } else if (action === 'remove') {
        removeSuggestion(suggestionKey);
    }
}

// UI functions
function appendSuggestionToList(suggestionKey, wordData) {
    const li = document.createElement('li');
    li.dataset.key = suggestionKey;

    // Left column: Base word
    const baseWordDiv = document.createElement('div');
    baseWordDiv.className = 'base-word';
    baseWordDiv.textContent = `${wordData.base_word} (${wordData.language || 'Unknown'})`;
    
    // Center column: Translations and Categories
    const centerColumn = document.createElement('div');
    centerColumn.className = 'center-column';
    
    const translationsDiv = document.createElement('div');
    translationsDiv.className = 'translations';
    
    const categoriesDiv = document.createElement('div');
    categoriesDiv.className = 'categories';
    
    centerColumn.appendChild(translationsDiv);
    centerColumn.appendChild(categoriesDiv);

    // Right column: Buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'button-container';
    
    const acceptButton = document.createElement('button');
    acceptButton.className = 'add-button';
    acceptButton.textContent = 'Accept';
    acceptButton.addEventListener('click', () => handleWordAction(suggestionKey, 'add', wordData));

    const declineButton = document.createElement('button');
    declineButton.className = 'remove-button';
    declineButton.textContent = 'Decline';
    declineButton.addEventListener('click', () => handleWordAction(suggestionKey, 'remove'));

    const translateButton = document.createElement('button');
    translateButton.className = 'translate-button';
    translateButton.textContent = 'Translate';
    translateButton.addEventListener('click', () => handleTranslation(suggestionKey, wordData));

    buttonContainer.appendChild(acceptButton);
    buttonContainer.appendChild(declineButton);
    buttonContainer.appendChild(translateButton);

    // Append all columns to the list item
    li.appendChild(baseWordDiv);
    li.appendChild(centerColumn);
    li.appendChild(buttonContainer);

    suggestionList.appendChild(li);

    if (wordData.translations && Object.keys(wordData.translations).length > 0) {
        updateUIWithTranslations(suggestionKey, wordData);
    }
}

// Update UI with translations
function updateUIWithTranslations(suggestionKey, wordData) {
    const suggestionItem = document.querySelector(`li[data-key="${suggestionKey}"]`);
    if (!suggestionItem) {
        console.error(`Suggestion item with key ${suggestionKey} not found`);
        return;
    }

    const translationsDiv = suggestionItem.querySelector('.translations');
    translationsDiv.innerHTML = '<strong>Translations:</strong> ';

    const priorityLanguages = ['ka', 'en', 'uk'];
    priorityLanguages.forEach(lang => {
        if (wordData.translations[lang]) {
            const translation = wordData.translations[lang];
            translationsDiv.innerHTML += `${lang}: ${translation.word} (${translation.difficulty}), `;
        }
    });

    // Remove trailing comma and space
    translationsDiv.innerHTML = translationsDiv.innerHTML.replace(/, $/, '');

    const categoriesDiv = suggestionItem.querySelector('.categories');
    categoriesDiv.innerHTML = '<strong>Categories:</strong> ';
    if (wordData.categories && wordData.categories.length > 0) {
        categoriesDiv.innerHTML += wordData.categories.join(', ');
    } else {
        categoriesDiv.innerHTML += 'None';
    }
}

// Import functions
async function importWordsFromTxt(file) {
    try {
        console.log("Starting import process...");

        const language = await askForLanguage();
        if (!language) {
            console.log("Language selection cancelled");
            return;
        }
        console.log(`Selected language: ${language}`);

        const words = await readWordsFromFile(file);
        console.log(`Read ${words.length} words from file`);

        if (words.length === 0) {
            alert('No words found in the file.');
            return;
        }

        console.log(`Importing ${words.length} words in ${language} language`);

        const existingWords = await getExistingWords();
        console.log(`Found ${existingWords.size} existing words`);

        const newWords = words.filter(word => !existingWords.has(word.toLowerCase()));
        console.log(`${newWords.length} new words to import`);

        if (newWords.length === 0) {
            alert('All words in the file already exist in the collection.');
            return;
        }

        // Show progress bar
        document.getElementById('progressBarContainer').style.display = 'block';

        await processAndImportWords(newWords, language);

        // Hide progress bar
        document.getElementById('progressBarContainer').style.display = 'none';

        alert(`Import complete. ${newWords.length} words added.`);
    } catch (error) {
        console.error('Error importing words:', error);
        alert(`An error occurred while importing words: ${error.message}`);
        // Hide progress bar in case of error
        document.getElementById('progressBarContainer').style.display = 'none';
    }
}

async function askForLanguage() {
    const supportedLanguages = await fetchSupportedLanguages();
    return new Promise((resolve) => {
        const select = document.createElement('select');
        supportedLanguages.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = lang;
            select.appendChild(option);
        });

        const dialog = document.createElement('dialog');
        dialog.innerHTML = `
            <form method="dialog">
                <h2>Select Language</h2>
                ${select.outerHTML}
                <button value="cancel">Cancel</button>
                <button value="default">OK</button>
            </form>
        `;

        document.body.appendChild(dialog);
        dialog.showModal();

        dialog.addEventListener('close', () => {
            if (dialog.returnValue !== 'cancel') {
                resolve(dialog.querySelector('select').value);
            } else {
                resolve(null);
            }
            document.body.removeChild(dialog);
        });
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
        const wordsSnapshot = await wordsCollection.get();
        const suggestionsSnapshot = await suggestedWordsCollection.get();
        
        return new Set([
            ...wordsSnapshot.docs.map(doc => doc.data().base_word.toLowerCase()),
            ...suggestionsSnapshot.docs.map(doc => doc.data().base_word.toLowerCase())
        ]);
    } catch (error) {
        console.error('Error fetching existing words:', error);
        throw error;
    }
}

async function processAndImportWords(words, language) {
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    progressBar.max = words.length;
    progressBar.value = 0;

    for (let i = 0; i < words.length; i++) {
        try {
            const word = words[i];
            console.log(`Processing word: ${word}`);

            const processedData = await processWordFully(word, language);
            if (!processedData) {
                console.error(`Failed to process word "${word}"`);
                continue;
            }

            const wordData = {
                base_word: word,
                language: language,
                categories: processedData.categories,
                translations: processedData.translations,
                last_updated: firebase.firestore.FieldValue.serverTimestamp()
            };

            // Generate a unique ID for the suggestion
            const suggestionKey = suggestedWordsCollection.doc().id;
            await suggestedWordsCollection.doc(suggestionKey).set(wordData);

            progressBar.value = i + 1;
            const progressPercentage = Math.round(((i + 1) / words.length) * 100);
            progressText.textContent = `${progressPercentage}% (${i + 1}/${words.length})`;
        } catch (error) {
            console.error(`Error processing word at index ${i}:`, error);
        }
    }
}

// Helper functions
function slugify(text) {
    const slug = text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-');
    
    return slug
}

// Event listeners
loginButton.addEventListener('click', login);
logoutButton.addEventListener('click', logout);

importButton.addEventListener('click', () => {
    importFileInput.click();
});

importFileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) {
        importWordsFromTxt(file);
    }
});

// Initialize function
function initApp() {
    updateUIForLoggedOutUser();
    firebase.auth().onAuthStateChanged(user => {
        if (user) {
            updateUIForLoggedInUser();
            setupListeners();
        }
    });
}

// Setup listeners for real-time updates
function setupListeners() {
    return suggestedWordsCollection.onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            const suggestionKey = change.doc.id;
            const wordData = change.doc.data();
            if (change.type === 'added') {
                appendSuggestionToList(suggestionKey, wordData);
            } else if (change.type === 'removed') {
                const suggestionItem = suggestionList.querySelector(`li[data-key="${suggestionKey}"]`);
                if (suggestionItem) {
                    suggestionItem.remove();
                }
            } else if (change.type === 'modified') {
                updateUIWithTranslations(suggestionKey, wordData);
            }
        });
    });
}

// Load suggestions on page load
async function loadSuggestions() {
    const snapshot = await suggestedWordsCollection.get();
    snapshot.forEach((doc) => {
        appendSuggestionToList(doc.id, doc.data());
    });
}

// Start the app
document.addEventListener('DOMContentLoaded', initApp);