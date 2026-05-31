export function maskPerson(person, revealSensitive = false) {
  if (revealSensitive) return person;
  return {
    ...person,
    school: person.school ? `${person.school.slice(0, 2)}***` : "",
    major: person.major ? `${person.major.slice(0, 2)}***` : "",
    hukou: person.hukou ? `${person.hukou.slice(0, 2)}***` : ""
  };
}
