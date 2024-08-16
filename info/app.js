function toggleBurgerMenu(){
    const menu = document.querySelector(".burger-menu")
    menu.classList.toggle('active')
}

document.querySelector('.burger-menu-icon').addEventListener('click', toggleBurgerMenu)
document.querySelector('.burger-menu-close').addEventListener('click', toggleBurgerMenu)

