console.log("index.html and app.js link established")

//Getting UI elements by their ID.
const monthDisplay = document.getElementById("month-display");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");

//Setting up calendar tracker with realtime data
const currentDate = new Date();
let currentMonthIndex = currentDate.getMonth();
let currentYear = currentDate.getFullYear();

//Grabbing all 42 day cells at once
const dayCells = document.querySelectorAll(".day-cell")

//loop that makes all cells editable
//dayCells.forEach(cell => {
//  cell.contentEditable = "true";
//});

const months = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function updateCalendar() {
  //writes month and year into h2 tag
  monthDisplay.textContent = months[currentMonthIndex] + ' ' + currentYear;

  //loops through all boxes and wipes them blank.
  for (let i = 0; i < dayCells.length; i++) {
    dayCells[i].innerHTML = "";
    dayCells[i].style.display = "flex";
  }

  //calculates calendar metrics for this specific month
  const firstDayIndex = new Date(currentYear, currentMonthIndex, 1).getDay();
  const totalDays = new Date(currentYear, currentMonthIndex + 1, 0).getDate();

  //distributes the day numbers across the empty cells
  for (let day = 1; day <= totalDays; day++) {
    const targetSlotIndex = firstDayIndex + day - 1;
    const cell = dayCells[targetSlotIndex];
    const dayNumberSpan = document.createElement("span");
    dayNumberSpan.classList.add("day-number");
    dayNumberSpan.textContent = day;

    const notesDiv = document.createElement("div");

    notesDiv.classList.add("notes-area");
    notesDiv.contentEditable = "true";

    cell.appendChild(dayNumberSpan);
    cell.appendChild(notesDiv);
  }
  //dayCells[targetSlotIndex].textContent = day;
}

//checks if 6th row is empty and hides it if needed
//if (dayCells[35].textContent === '') 
if (firstDayIndex + totalDays <= 35) {
  //for (let i = 35; 1 < 42; i++) {
  dayCells[i].style.display = "none";
}
}
}

prevBtn.addEventListener("click", () => {
  currentMonthIndex = currentMonthIndex - 1;
  if (currentMonthIndex < 0) {
    currentMonthIndex = 11;
    currentYear = currentYear - 1;
  }


  updateCalendar();
});

nextBtn.addEventListener("click", () => {
  currentMonthIndex = currentMonthIndex + 1;
  if (currentMonthIndex > 11) {
    currentMonthIndex = 0;
    currentYear = currentYear + 1;
  }

  updateCalendar();
});

updateCalendar();
