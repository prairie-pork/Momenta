console.log("index.html and app.js link established")

//Getting Date, and extracting month from date data
const currentDate = new Date();
const currentMonthNumber = currentDate.getMonth();

const monthDisplay = document.getElementById("month-display");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");

let currentMonthIndex = currentMonthNumber;

const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

console.log("The current month is: " + currentMonthNumber)

function updateCalendar() {
    monthDisplay.textContent = months[currentMonthIndex];
}

prevBtn.addEventListener("click", () => {
    currentMonthIndex = currentMonthIndex - 1;

    if (currentMonthIndex < 0) {
        currentMonthIndex = 11;
    }

    updateCalendar();
});

nextBtn.addEventListener("click", () => {
    currentMonthIndex = currentMonthIndex + 1;

    if (currentMonthIndex > 11) {
        currentMonthIndex = 0;
    }

    updateCalendar();
});

updateCalendar();
