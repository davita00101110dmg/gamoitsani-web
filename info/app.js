function toggleBurgerMenu(){
    const menu = document.querySelector(".burger-menu")
    const overlay = document.querySelector('.overlay')
    menu.classList.toggle('active')
    overlay.classList.toggle('active')
}

document.querySelector('.burger-menu-icon').addEventListener('click', toggleBurgerMenu)
document.querySelector('.burger-menu-close').addEventListener('click', toggleBurgerMenu)
document.querySelector('.overlay').addEventListener('click', toggleBurgerMenu)

