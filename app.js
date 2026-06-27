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

    // Create a span for the day number (not editable)
    const dayNumberSpan = document.createElement('span');
    dayNumberSpan.classList.add('day-number');
    dayNumberSpan.textContent = day;

    //div for the notes (editable) OLD CODE
    //const notesDiv = document.createElement('div');
    //notesDiv.classList.add('notes-area');
    //notesDiv.contentEditable = "true"; 

    //container to hold two columns side by side
    const notesContainer = document.createElement('div');
    notesContainer.classList.add('notes-container')

    //left column text field
    const col1 = document.createElement('div');
    col1.classList.add('notes-column');
    col1.contentEditable = "true";

    //right column text field
    const col2 = document.createElement('div');
    col2.classList.add('notes-column');
    col2.contentEditable = "true";

    const savedData = localStorage.getItem(`momento-${currentYear}-${currentMonthIndex}-${day}`);
    if (savedData) {
      const parsedData = JSON.parse(savedData);
      col1.innerText = parsedData.col1 || '';
      col2.innerText = parsedData.col2 || '';
    }

    //watch enter key so it goes to column 2 when full
    col1.addEventListener('input', () => {
      if (col1.scrollHeight > col1.clientHeight) {
        const text = col1.innerText;
        col1.innerText = text.slice(0, -1);
        col2.focus();
        col2.innerText = text.slice(-1);

        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(col2);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      localStorage.setItem(`momento-${currentYear}-${currentMonthIndex}-${day}`, JSON.stringify({ col1: col1.innerText, col2: col2.innerText }));
    });

    //watch enter key on column 2 so that it prevents extra vertical lines
    col2.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // temporarily clear layout constraints to measure true text content footprint
        col2.style.height = 'auto';
        col2.style.alignSelf = 'flex-start';
        const contentHeight = col2.scrollHeight;

        // instantly restore layout styles
        col2.style.height = '';
        col2.style.alignSelf = '';

        // calculate remaining vertical room
        const remainingSpace = col2.clientHeight - contentHeight;

        if (remainingSpace < 18) {
          e.preventDefault();
        }
      }
    });

    col2.addEventListener('input', () => {

      col2.style.height = 'auto';
      col2.style.alignSelf = 'flex-start';
      const contentHeight = col2.scrollHeight;

      col2.style.height = '';
      col2.style.alignSelf = '';

      if (contentHeight > col2.clientHeight) {
        col2.innerText = col2.innerText.slice(0, -1);

        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(col2);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      localStorage.setItem(`momento-${currentYear}-${currentMonthIndex}-${day}`, JSON.stringify({ col1: col1.innerText, col2: col2.innerText }));
    });

    // append both columns into layout container
    notesContainer.appendChild(col1);
    notesContainer.appendChild(col2);

    //append the number and the column layout container to the calendar cell
    cell.appendChild(dayNumberSpan);
    cell.appendChild(notesContainer);

    //checks if 6th row is empty and hides it if needed
    if (firstDayIndex + totalDays <= 35) {
      for (let i = 35; i < 42; i++) {
        dayCells[i].style.display = "none";
      }
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
