// Models
const { Managers } = require("../../config/model");


// Check if manager exist
async function checkExistManager(user_login) {
    if (!user_login)
        return { failed: true, resp_obj: {code: 0, msg: "Необходимо ввести логин"} };

    let manager = await Managers.findOne({login: user_login}).select("nickName").lean()

    if (!manager) 
        return { failed: true, resp_obj: {code: 0, msg: "Сотрудник с таким логином не найден"} };

    return { failed: false, resp_obj: manager };
}


// Check is valid date 
function isValidDate(date) {
    if(!date) 
        return false;

    if (new Date(date) < new Date().setHours(0, 0, 0, 0)) 
        return false;

    return true;    
}


// Create update object for tehcards with deleted autoplanning 
function makeUpdateObjForAutoPlanningDeletedCards(dataset_for_pl_deleting) {
    let cards_numbers_for_update = [];
    for (n = 0; n < dataset_for_pl_deleting.length; n++) 
        cards_numbers_for_update[n] = dataset_for_pl_deleting[n].number;
   
    let set_mark_obj = {
        updateMany: {
            filter: { "number": { $in: cards_numbers_for_update } },
            update: { $set: { "workProperties.deleted_automatic_planning": true } }
        }
    }
    
    return set_mark_obj;
}


module.exports.checkExistManager = checkExistManager;
module.exports.makeUpdateObjForAutoPlanningDeletedCards = makeUpdateObjForAutoPlanningDeletedCards;
module.exports.isValidDate = isValidDate;