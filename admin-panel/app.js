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

// Your Google Cloud API key
const apiKey = window.config.GOOGLE_API_KEY;

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const suggestedWordsCollection = db.collection("suggested-words");
const wordsCollection = db.collection("words");

// DOM elements
const suggestionList = document.getElementById('suggestionList');
const suggestionForm = document.getElementById('suggestionForm');
const authModal = document.getElementById('authModal');
const appContent = document.getElementById('appContent');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginButton = document.getElementById('loginButton');
const loginError = document.getElementById('loginError'); 
const logoutButton = document.getElementById('logoutButton'); 
const importButton = document.getElementById('importButton');
const importFileInput = document.getElementById('importFileInput');



// --- Authentication ---
// Handle login
loginButton.addEventListener('click', async () => {
    const email = emailInput.value;
    const password = passwordInput.value;
    try {
        await firebase.auth().signInWithEmailAndPassword(email, password);
        console.log('User logged in successfully.');
        updateUIForLoggedInUser();
    } catch (error) {
        console.error('Error logging in:', error);
        loginError.textContent = error.message; // Show error in the modal
    }
});

// Handle logout
logoutButton.addEventListener('click', () => {
    firebase.auth().signOut()
        .then(() => {
            console.log('User logged out.');
            updateUIForLoggedOutUser();
        })
        .catch(error => {
            console.error('Error logging out:', error);
        });
});

// Update UI based on authentication state
function updateUIForLoggedInUser() {
    authModal.style.display = 'none';
    appContent.style.display = 'block';
    loginError.textContent = ''; // Clear any previous error messages
}

function updateUIForLoggedOutUser() {
    authModal.style.display = 'block';
    appContent.style.display = 'none';
    suggestionList.innerHTML = ''; // Clear the suggestion list on logout
}

// Initial UI state and check for existing login
updateUIForLoggedOutUser();
firebase.auth().onAuthStateChanged(user => {
    if (user) {
        updateUIForLoggedInUser();
    }
});

// --- Translation ---
async function translateWord(word, targetLang) {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: word, target: targetLang })
        });
        const data = await response.json();
        if (data.error) {
            throw new Error(data.error.message);
        }
        return data.data.translations[0].translatedText.charAt(0).toUpperCase() + data.data.translations[0].translatedText.slice(1);
    } catch (error) {
        console.error('Translation error:', error);
        return null; 
    }
}

// --- Firestore Operations ---
async function addSuggestionToWords(suggestionKey, wordData) {
    const { word_ka, word_en, definitions, categories } = wordData;

    if (!word_en) wordData.word_en = await translateWord(word_ka, 'en');
    if (!word_ka) wordData.word_ka = await translateWord(word_en, 'ka');

    try {
        const existingWord = await wordsCollection.where('word_ka', '==', wordData.word_ka).get();
        if (!existingWord.empty) {
            console.log(`Word "${wordData.word_ka}" already exists.`);
            return await suggestedWordsCollection.doc(suggestionKey).delete();
        }

        // Remove the admin parameter
        await wordsCollection.add(wordData); 

        console.log(`Word "${wordData.word_ka}" added to "words" collection.`);
        return await suggestedWordsCollection.doc(suggestionKey).delete();
    } catch (error) {
        console.error('Error adding word to "words" collection:', error);
    }
}

async function removeSuggestion(suggestionKey) {
    try {
        await suggestedWordsCollection.doc(suggestionKey).delete();
        console.log(`Suggestion with key "${suggestionKey}" removed.`);
    } catch (error) {
        console.error('Error removing suggestion:', error);
    }
}

// --- UI Interactions ---
function createElementWithClass(tagName, className) {
    const element = document.createElement(tagName);
    element.classList.add(className);
    return element;
}

function appendSuggestionToList(suggestionKey, wordData) {
    const { word_ka, word_en, definitions, categories } = wordData;

    const li = document.createElement('li');
    li.dataset.key = suggestionKey;

    const wordKADiv = createElementWithClass('div', 'word-ka');
    wordKADiv.textContent = `Georgian Word: ${word_ka}`;
    li.appendChild(wordKADiv);

    const wordENDiv = createElementWithClass('div', 'word-en');
    wordENDiv.textContent = `English Word: ${word_en}`;
    li.appendChild(wordENDiv);

    if (definitions && definitions.length > 0) {
        const definitionsDiv = createElementWithClass('div', 'definitions');
        definitionsDiv.textContent = `Definitions: ${definitions.join(', ')}`;
        li.appendChild(definitionsDiv);
    }

    if (categories && categories.length > 0) {
        const categoriesDiv = createElementWithClass('div', 'categories');
        categoriesDiv.textContent = `Categories: ${categories.join(', ')}`;
        li.appendChild(categoriesDiv);
    }

    const buttonContainer = document.createElement('div');
    const acceptButton = createElementWithClass('button', 'add-button');
    acceptButton.textContent = 'Accept';
    acceptButton.addEventListener('click', () => handleWordAction(suggestionKey, 'add', wordData));

    const declineButton = createElementWithClass('button', 'remove-button');
    declineButton.textContent = 'Decline';
    declineButton.addEventListener('click', () => handleWordAction(suggestionKey, 'remove'));

    const translateButton = createElementWithClass('button', 'translate-button');
    translateButton.textContent = 'Translate';
    translateButton.addEventListener('click', () => handleTranslation(suggestionKey, wordData));

    const editButton = createElementWithClass('button', 'edit-button');
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', () => handleEdit(suggestionKey, wordData));

    buttonContainer.appendChild(acceptButton);
    buttonContainer.appendChild(declineButton);
    buttonContainer.appendChild(translateButton);
    buttonContainer.appendChild(editButton);
    li.appendChild(buttonContainer);

    suggestionList.appendChild(li);
}

function handleTranslation(suggestionKey, wordData) {
    const { word_ka, word_en } = wordData;
    const updateUI = () => updateUIWithTranslations(suggestionKey, wordData);

    if (!word_en && word_ka) {
        translateWord(word_ka, 'en').then(translated => {
            wordData.word_en = translated;
            updateUI();
        });
    } else if (!word_ka && word_en) {
        translateWord(word_en, 'ka').then(translated => {
            wordData.word_ka = translated;
            updateUI();
        });
    }
}

function updateUIWithTranslations(suggestionKey, wordData) {
    const suggestionItem = suggestionList.querySelector(`li[data-key="${suggestionKey}"]`);
    if (suggestionItem) {
        suggestionItem.querySelector('.word-ka').textContent = `Georgian Word: ${wordData.word_ka}`;
        suggestionItem.querySelector('.word-en').textContent = `English Word: ${wordData.word_en}`;
    }
}

function arraysEqual(arr1, arr2) {
    if (arr1.length !== arr2.length) return false;
    for (let i = 0; i < arr1.length; i++) {
        if (arr1[i] !== arr2[i]) return false;
    }
    return true;
}

function handleEdit(suggestionKey, wordData) {
    const { word_ka, word_en, definitions = [], categories = [] } = wordData;

    // Collect new values
    const newValues = {};

    const newWordKA = prompt('Enter new Georgian Word:', word_ka);
    if (newWordKA !== null && newWordKA.trim() !== word_ka) {
        newValues.word_ka = newWordKA.trim();
    }

    const newWordEN = prompt('Enter new English Word:', word_en);
    if (newWordEN !== null && newWordEN.trim() !== word_en) {
        newValues.word_en = newWordEN.trim();
    }

    // Check if definitions exist and is an array before joining
    const newDefinitions = prompt(
        'Enter new Definitions (comma-separated):', 
        Array.isArray(definitions) && definitions.length > 0 ? definitions.join(', ') : ""
    );
    if (newDefinitions !== null) {
        const trimmedDefinitions = newDefinitions.split(',').map(def => def.trim());
        if (!arraysEqual(trimmedDefinitions, definitions)) {
            newValues.definitions = trimmedDefinitions;
        }
    }
    
    // Check if categories exist and is an array before joining
    const newCategories = prompt(
        'Enter new Categories (comma-separated):',
        Array.isArray(categories) && categories.length > 0 ? categories.join(', ') : ""
    );
    if (newCategories !== null) {
        const trimmedCategories = newCategories.split(',').map(cat => cat.trim());
        if (!arraysEqual(trimmedCategories, categories)) {
            newValues.categories = trimmedCategories;
        }
    }

    // Function to update Firestore document if it exists
    function updateDocumentIfExist(suggestionKey, newValues) {
        suggestedWordsCollection.doc(suggestionKey).get()
            .then(doc => {
                if (doc.exists) {
                    const updatedWordData = {
                        word_ka: newValues.word_ka || word_ka,
                        word_en: newValues.word_en || word_en,
                        definitions: newValues.definitions || definitions,
                        categories: newValues.categories || categories
                    };

                    // Document exists, proceed with update
                    return suggestedWordsCollection.doc(suggestionKey).update(updatedWordData)
                        .then(() => {
                            console.log(`Document with key "${suggestionKey}" updated successfully.`);
                            // Update local wordData with new values
                            Object.assign(wordData, updatedWordData);
                            // Update UI with new values
                            updateUIWithEdits(suggestionKey, wordData);
                        })
                        .catch(error => {
                            console.error('Error updating document:', error);
                        });
                } else {
                    console.error(`Document with key "${suggestionKey}" does not exist.`);
                }
            })
            .catch(error => {
                console.error('Error fetching document:', error);
            });
    }

    // Update Firestore document if there are changes
    if (Object.keys(newValues).length > 0) {
        updateDocumentIfExist(suggestionKey, newValues);
    } else {
        console.log('No changes made.');
    }
}

function updateUIWithEdits(suggestionKey, wordData) {
    const suggestionItem = suggestionList.querySelector(`li[data-key="${suggestionKey}"]`);
    if (suggestionItem) {
        suggestionItem.querySelector('.word-ka').textContent = `Georgian Word: ${wordData.word_ka}`;
        suggestionItem.querySelector('.word-en').textContent = `English Word: ${wordData.word_en}`;

        const definitionsDiv = suggestionItem.querySelector('.definitions');
        if (wordData.definitions && wordData.definitions.length > 0) {
            definitionsDiv.textContent = `Definitions: ${wordData.definitions.join(', ')}`;
            definitionsDiv.style.display = 'block'; // Show definitions if not empty
        } else {
            definitionsDiv.style.display = 'none'; // Hide definitions if empty
        }

        const categoriesDiv = suggestionItem.querySelector('.categories');
        if (wordData.categories && wordData.categories.length > 0) {
            categoriesDiv.textContent = `Categories: ${wordData.categories.join(', ')}`;
            categoriesDiv.style.display = 'block'; // Show categories if not empty
        } else {
            categoriesDiv.style.display = 'none'; // Hide categories if empty
        }
    }
}

function handleWordAction(suggestionKey, action, wordData) {
    if (action === 'add') {
        addSuggestionToWords(suggestionKey, wordData);
    } else if (action === 'remove') {
        removeSuggestion(suggestionKey);
    }
}

// --- Listeners ---
function setupListeners() {
    const suggestionsListener = suggestedWordsCollection.onSnapshot((snapshot) => {
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
            }
        });
    });

    // Clean up listeners when the component is unmounted
    return () => suggestionsListener();
}

// Wait for the DOM to load before setting up listeners
document.addEventListener('DOMContentLoaded', () => {
    const cleanupListeners = setupListeners();

    // Clean up listeners before the page unloads
    window.addEventListener('beforeunload', cleanupListeners);
});

// Listen for form submissions to add new suggestions
document.getElementById('suggestionForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    const wordData = {
        word_ka: event.target.elements.word_ka.value.trim(),
        word_en: event.target.elements.word_en.value.trim(),
        definitions: event.target.elements.definitions.value.split(',').map(def => def.trim()),
        categories: event.target.elements.categories.value.split(',').map(cat => cat.trim())
    };

    // Determine if translation is needed
    if (!wordData.word_en && wordData.word_ka) {
        wordData.word_en = await translateAndCapitalize(wordData.word_ka, 'en');
    } else if (!wordData.word_ka && wordData.word_en) {
        wordData.word_ka = await translateAndCapitalize(wordData.word_en, 'ka');
    }

    try {
        await suggestedWordsCollection.add(wordData);
        console.log('Suggestion added:', wordData);
        event.target.reset(); // Clear the form after submission
    } catch (error) {
        console.error('Error adding suggestion:', error);
    }
});

importButton.addEventListener('click', () => {
    importFileInput.click(); // Trigger the hidden file input
  });

  importFileInput.addEventListener('change', () => {
    const file = importFileInput.files[0];
    if (file) {
      importWordsFromTxt(file);
    }
  });

// --- Import Words from TXT ---
async function importWordsFromTxt(file) {
    try {
      const reader = new FileReader();
  
      reader.onload = async (event) => {
        const fileContent = event.target.result;
        const words = fileContent.split('\n').filter(word => word.trim() !== '');
  
        // Get existing English words from Firestore
        const existingWordsSnapshot = await suggestedWordsCollection.get();
        const existingWordSet = new Set(existingWordsSnapshot.docs.map(doc => doc.data().word_en.toLowerCase()));
  
        // Filter out duplicates and existing words
        const uniqueNewWords = words.filter((word, index) => {
          const trimmedWord = word.trim();
          const capitalizedWord = trimmedWord.charAt(0).toUpperCase() + trimmedWord.slice(1);
          return words.indexOf(trimmedWord) === index && !existingWordSet.has(capitalizedWord.toLowerCase());
        });
  
        if (uniqueNewWords.length === 0) {
          alert('No new unique words found to import.');
          return;
        }
  
        // Show progress bar and initialize
        document.getElementById('progressBarContainer').style.display = 'block';
        const progressBar = document.getElementById('progressBar');
        const progressText = document.getElementById('progressText');
        const totalWords = uniqueNewWords.length;
        let wordsProcessed = 0;
        progressBar.max = totalWords;
  
        const batch = db.batch();
        for (const word of uniqueNewWords) {
          const trimmedWord = word.trim();
          const capitalizedWord = trimmedWord.charAt(0).toUpperCase() + trimmedWord.slice(1); // Capitalize the english word
  
          // Translate the word to Georgian
          const word_ka = await translateWord(capitalizedWord, 'ka') ?? 'Translation Failed'; // Handle potential translation failures
  
          const wordData = {
            word_en: capitalizedWord,
            word_ka: word_ka,
            definitions: [],  // Explicitly set as an empty array
            categories: []   // Explicitly set as an empty array
          };
  
          const docRef = suggestedWordsCollection.doc();
          batch.set(docRef, wordData);
  
          // Update progress after each word is processed
          wordsProcessed++;
          const progressPercent = Math.round((wordsProcessed / totalWords) * 100);
          progressBar.value = wordsProcessed;
          progressText.textContent = `${progressPercent}%`;
        }
  
        await batch.commit();
        // Hide progress bar after import is complete
        document.getElementById('progressBarContainer').style.display = 'none'; 
        alert('Words imported successfully!');
      };
  
      reader.onerror = (error) => {
          console.error('Error reading file:', error);
          alert('Error reading file.');
      };
  
      reader.readAsText(file); // Read the file as text
    } catch (error) {
      console.error('Error importing words:', error);
      alert('Error importing words.');
    }
  }
  