const csvText = `student_id,student_name,student_email,assigned_tests
S001,Alice Smith,alice.smith@school.edu,TEST_1;TEST_2
S002,Bob Jones,bob.jones@school.edu,TEST_1
S003,Charlie,charlie@school.edu,TEST_2`;

const parseCSVLine = (line: string): string[] => {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += char;
    }
  }
  result.push(cur.trim());
  return result;
};

const lines = csvText.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l.length > 0);
const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().trim().replace(/["']/g, ''));
const idIdx = headers.findIndex(h => h.includes('id') || h.includes('student_id'));
const nameIdx = headers.findIndex(h => h.includes('name') || h.includes('student_name'));
const assignedIdx = headers.findIndex(h => h.includes('assigned') || h.includes('tests') || h.includes('assigned_tests'));
const emailIdx = headers.findIndex(h => h.includes('email') || h.includes('mail') || h.includes('address'));

console.log({ idIdx, nameIdx, assignedIdx, emailIdx, headers });

const newStudents = [];
for (let i = 1; i < lines.length; i++) {
  const cells = parseCSVLine(lines[i]);
  if (cells.length < Math.max(idIdx, nameIdx) + 1) continue;
  const studentId = cells[idIdx].replace(/["']/g, '');
  const studentName = cells[nameIdx].replace(/["']/g, '');
  if (!studentId || !studentName) continue;

  let assigned: string[] = [];
  if (assignedIdx !== -1 && cells[assignedIdx]) {
    assigned = cells[assignedIdx]
      .replace(/["']/g, '')
      .split(';')
      .map((t: string) => t.trim().toUpperCase())
      .filter((t: string) => t.length > 0);
  }

  let email: string | undefined = undefined;
  if (emailIdx !== -1 && cells[emailIdx]) {
    email = cells[emailIdx].replace(/["']/g, '').trim();
  }

  newStudents.push({
    student_id: studentId,
    student_name: studentName,
    assigned_tests: assigned,
    email: email || undefined
  });
}
console.log(newStudents);
