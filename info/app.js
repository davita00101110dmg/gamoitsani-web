function toggleBurgerMenu() {
  const menu = document.querySelector(".burger-menu");
  const overlay = document.querySelector(".overlay");
  menu.classList.toggle("active");
  overlay.classList.toggle("active");
}

document
  .querySelector(".burger-menu-icon")
  .addEventListener("click", toggleBurgerMenu);
document
  .querySelector(".burger-menu-close")
  .addEventListener("click", toggleBurgerMenu);
document.querySelector(".overlay").addEventListener("click", toggleBurgerMenu);

// animation ???

function createQuestionMarks() {
  const container = document.querySelector(".background-container");
  const numberOfMarks = 100;

  for (let i = 0; i < numberOfMarks; i++) {
    const questionMark = document.createElement("div");
    questionMark.classList.add("question-mark");
    const x = Math.random() * 100;
    const y = Math.random() * 100;
    const duration = Math.random() * 60 + 20;

    questionMark.style.left = `${x}vw`;
    questionMark.style.top = `${y}vh`;
    questionMark.style.animationDuration = `${duration}s`;

    container.appendChild(questionMark);
  }
}

createQuestionMarks();


// faq

document.addEventListener('DOMContentLoaded', function () {
  const faqItems = document.querySelectorAll('.faq-item');

  faqItems.forEach(item => {
    item.querySelector('.faq-question').addEventListener('click', function () {
      const isOpen = item.classList.contains('open');
      faqItems.forEach(i => i.classList.remove('open'));
      if (!isOpen) {
        item.classList.add('open');
      }
    });
  });
});



// language toggle


function switchLanguage(language) {
  const geElements = document.querySelectorAll('[data-ge]');
  
  geElements.forEach(el => {
    if (language === 'ge') {
      const imgElement = el.querySelector('img');
      const imgHTML = imgElement ? imgElement.outerHTML : '';
      const text = el.getAttribute('data-ge');
      el.innerHTML = imgHTML + text;
    } else if (language === 'en') {
      const imgElement = el.querySelector('img');
      const imgHTML = imgElement ? imgElement.outerHTML : '';
      const text = el.getAttribute('data-en');
      el.innerHTML = imgHTML + text;
    }
  });
}

