const container = document.querySelector('.container');
const numQuestionMarks = 25;

for (let i = 0; i < numQuestionMarks; i++) {
    const questionMark = document.createElement('div');
    const rotateDirection = Math.random() < 0.5 ? 1 : -1;

    questionMark.classList.add('question-mark');
    questionMark.textContent = '?';

    // Random starting position (set as custom properties)
    questionMark.style.setProperty('--start-top', `${Math.random() * 100}%`);
    questionMark.style.setProperty('--start-left', `${Math.random() * 100}%`);

    // Set custom properties for random direction
    questionMark.style.setProperty('--random-direction-x', Math.random()); // 0 or 1
    questionMark.style.setProperty('--random-direction-y', Math.random()); // 0 or 1

    questionMark.style.setProperty('--rotate-direction', rotateDirection);

    // Randomize rotation speed (between 5 and 15 seconds)
    const rotateDuration = (Math.random() * 10 + 5).toFixed(2) + 's'; 
    questionMark.style.animation = `moveRandomly 15s linear infinite, slowRotate ${rotateDuration} linear infinite`;


    container.appendChild(questionMark);
}